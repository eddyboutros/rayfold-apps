/**
 * The service started on an empty database while another service of the fleet is migrating: it waits for the fleet's
 * migration lock before it creates a table, then starts. The test holds the lock itself, so the turn is seen in
 * `pg_locks` rather than timed.
 */
package keel.approvals

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.springframework.boot.builder.SpringApplicationBuilder
import org.springframework.context.ConfigurableApplicationContext
import java.net.URI
import java.sql.Connection
import java.sql.DriverManager
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals

@Timeout(120)
class MigrationsTest {
    private val base: String = System.getenv("TEST_DATABASE_URL") ?: "postgres://postgres:rayfold@127.0.0.1:55432/apps_test"
    private val name = "apps_fresh_jvm_${ProcessHandle.current().pid()}_${System.currentTimeMillis()}"
    private lateinit var holder: Connection
    private var context: ConfigurableApplicationContext? = null

    private fun jdbc(database: String): Connection {
        val uri = URI(base)
        val (user, password) = (uri.userInfo ?: "postgres:").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
        return DriverManager.getConnection("jdbc:postgresql://${uri.host}:${uri.port}/$database?loginTimeout=10", user, password)
    }

    private val fresh: String get() = base.replace(URI(base).path, "/$name")

    @BeforeEach
    fun createDatabase() {
        jdbc("postgres").use { c -> c.createStatement().use { it.execute("create database \"$name\"") } }
        holder = jdbc(name)
    }

    @AfterEach
    fun dropDatabase() {
        context?.close()
        holder.close()
        jdbc("postgres").use { c -> c.createStatement().use { it.execute("drop database if exists \"$name\" with (force)") } }
    }

    private fun waiting(): Int = holder.prepareStatement(
        "select count(*) from pg_locks where locktype = 'advisory' and objid = ? and not granted and database = (select oid from pg_database where datname = ?)",
    ).use { s ->
        s.setLong(1, MIGRATION_LOCK)
        s.setString(2, name)
        s.executeQuery().use { it.next(); it.getInt(1) }
    }

    private fun table(t: String): Boolean = holder.prepareStatement("select to_regclass(?) is not null").use { s ->
        s.setString(1, t)
        s.executeQuery().use { it.next(); it.getBoolean(1) }
    }

    private fun lock(sql: String) = holder.createStatement().use { it.execute(sql.replace("KEY", MIGRATION_LOCK.toString())) }

    @Test
    fun `waits for the fleet's migration lock before it creates a table, and starts once it has it`() {
        lock("select pg_advisory_lock(KEY)")
        val starting = CompletableFuture.supplyAsync {
            // as arguments, which outrank application.properties, as the environment does in a deploy
            SpringApplicationBuilder(ApprovalsApplication::class.java).run("--server.port=0", "--keel.database-url=$fresh", "--keel.instance=approvals-migrations", "--keel.version=test")
        }
        // bounded: the service asks for the lock within the deadline or the test fails saying so
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (waiting() != 1) {
            if (System.nanoTime() > deadline) throw AssertionError("the service never waited for the migration lock")
            if (starting.isDone) {
                starting.get() // a start that failed says why here
                throw AssertionError("the service started without waiting for the migration lock")
            }
            Thread.onSpinWait()
        }
        assertEquals(listOf(false, false, false), listOf(table("approvals"), table("rayfold_idempotency"), table("rayfold_relay")))

        lock("select pg_advisory_unlock(KEY)")
        context = starting.get(60, TimeUnit.SECONDS)
        assertEquals(listOf(true, true, true), listOf(table("approvals"), table("rayfold_idempotency"), table("rayfold_relay")))
        // and it let go: nobody waits, and the lock is free to take
        assertEquals(0, waiting())
        holder.createStatement().use { s -> s.executeQuery("select pg_try_advisory_lock($MIGRATION_LOCK)").use { it.next(); assertEquals(true, it.getBoolean(1)) } }
        lock("select pg_advisory_unlock(KEY)")
    }
}
