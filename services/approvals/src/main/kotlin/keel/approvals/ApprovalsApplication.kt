/**
 * The approvals service: the fleet's JVM member.
 *
 * The Spring Boot starter serves the schema at `/rayfold` and the WebSocket at `/rayfold/ws`; what this file adds is
 * what makes the process one of a fleet rather than a server on its own. The idempotency store and the relay are the
 * same two tables the TypeScript services write, so a retry that lands here after landing there replays, and a
 * command run here wakes a live query open there. The session is the same cookie; the roster is the same list.
 */
package keel.approvals

import dev.rayfold.core.BatchOptions
import dev.rayfold.core.HttpCall
import dev.rayfold.core.HttpOptions
import dev.rayfold.core.MemoryCounters
import dev.rayfold.core.MemoryUsage
import dev.rayfold.core.RayfoldHttp
import dev.rayfold.core.RayfoldSchemaIR
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.ServerIdentity
import dev.rayfold.jdbc.JdbcIdempotencyStore
import dev.rayfold.jdbc.PgNotifications
import dev.rayfold.jdbc.PgRelay
import dev.rayfold.spring.RayfoldProperties
import dev.rayfold.spring.RayfoldViewerResolver
import jakarta.servlet.http.HttpServletRequest
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.apache.commons.logging.LogFactory
import org.springframework.boot.SpringApplication
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.event.EventListener
import java.net.URI
import java.sql.Connection
import java.sql.DriverManager
import java.util.UUID
import javax.sql.DataSource

@SpringBootApplication
class ApprovalsApplication

fun main(args: Array<String>) {
    SpringApplication.run(ApprovalsApplication::class.java, *args)
}

/** `keel.*`: what the fleet hands every service through its environment. */
@ConfigurationProperties("keel")
class KeelProperties {
    /** `postgres://user:pass@host:port/db`, as the TypeScript services take it. */
    var databaseUrl: String = "postgres://postgres:rayfold@127.0.0.1:55432/apps"
    /** Bearer token that may read `/rayfold/stats`; empty leaves the route off. */
    var opsToken: String = ""
    var version: String = "dev"
    var instance: String = ""
}

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(KeelProperties::class)
class FleetConfiguration {
    private val log = LogFactory.getLog(FleetConfiguration::class.java)

    /** The fleet's `postgres://` URL as JDBC: one parse, so the compose file and the dev script need no second form. */
    @Bean
    fun dataSource(keel: KeelProperties): DataSource {
        val uri = URI(keel.databaseUrl)
        val (user, password) = (uri.userInfo ?: "postgres:").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
        val jdbc = "jdbc:postgresql://${uri.host}:${if (uri.port > 0) uri.port else 5432}${uri.path}"
        return org.springframework.jdbc.datasource.DriverManagerDataSource(jdbc, user, password)
    }

    @Bean
    fun store(dataSource: DataSource): ApprovalStore = ApprovalStore(dataSource::getConnection).also { it.migrate() }

    /** Records shared with the rest of the fleet: a keyed command runs once, whichever runtime the retry reaches. */
    @Bean
    fun idempotency(dataSource: DataSource): JdbcIdempotencyStore = JdbcIdempotencyStore(dataSource::getConnection).also { it.migrate() }

    /**
     * The relay over Postgres NOTIFY, in the format the TypeScript services speak. LISTEN holds its connection for as
     * long as it listens, so it gets one of its own, out of the pool; sending uses the pool.
     */
    @Bean
    fun relay(dataSource: DataSource): PgRelay {
        val listener: Connection = dataSource.connection
        return PgRelay(PgNotifications(listener, dataSource::getConnection), dataSource::getConnection).also { it.migrate() }
    }

    /**
     * The server, built here rather than by the starter so that it says who it is and counts what it does, as every
     * service in the fleet does: `/rayfold/stats` is what a console reads to tell instances apart.
     */
    @Bean
    fun rayfoldServer(schema: RayfoldSchemaIR, properties: RayfoldProperties, keel: KeelProperties, store: ApprovalStore, idempotency: JdbcIdempotencyStore, relay: PgRelay): RayfoldServer {
        val server = RayfoldServer(
            schema,
            approvalResolvers(store),
            BatchOptions(trustedShapes = properties.trustedShapes, budget = properties.budget, maxDepth = properties.maxDepth),
            idempotency = idempotency,
            usage = MemoryUsage(),
            relay = relay,
            onRelayError = { log.error("relay refused a message", it) },
            identity = ServerIdentity(name = "approvals", version = keel.version, instance = keel.instance.ifEmpty { "approvals-" + UUID.randomUUID().toString().take(8) }),
            counters = MemoryCounters(),
        )
        hearTheFleet(server, store, log)
        return server
    }

    /** Stats behind the ops token, readiness that asks the database, and the same origin rules as the starter's. */
    @Bean
    fun rayfoldHttp(server: RayfoldServer, properties: RayfoldProperties, keel: KeelProperties, dataSource: DataSource): RayfoldHttp = RayfoldHttp(
        server,
        HttpOptions(
            allowedOrigins = properties.allowedOrigins.toSet(),
            allowedHosts = properties.allowedHosts?.toSet(),
            manifest = properties.manifest,
            maxBodyBytes = properties.maxBodyBytes,
            explorer = properties.explorer.enabled,
            explorerTitle = properties.explorer.title,
            readiness = mapOf("db" to { dataSource.connection.use { c -> c.createStatement().use { it.execute("select 1") } }; Unit }),
            stats = if (keel.opsToken.isEmpty()) null else { call: HttpCall -> call.header("authorization") == "Bearer ${keel.opsToken}" },
        ),
    )

    /** The same session as the rest of the fleet: a bearer handle for a program, the cookie for a browser. */
    @Bean
    fun viewer(): RayfoldViewerResolver = RayfoldViewerResolver { request: HttpServletRequest ->
        val person = Roster.of(request.getHeader("authorization"), request.getHeader("cookie"))
        if (person == null) JsonNull else buildJsonObject { put("id", person.id); put("name", person.name) }
    }

    /** Listening to the others once the port is open: readiness says "relay: not listening yet" until then. */
    @EventListener
    fun onReady(event: ApplicationReadyEvent) {
        val server = event.applicationContext.getBean(RayfoldServer::class.java)
        runBlocking { server.ready() }
        val keel = event.applicationContext.getBean(KeelProperties::class.java)
        log.info("[approvals] started " + buildJsonObject { put("version", keel.version); put("instance", server.identity.instance) })
    }
}

/** Keeps the JDBC driver on the classpath where a `DriverManagerDataSource` finds it, and nothing else. */
@Suppress("unused")
private val postgresDriver = DriverManager::class
