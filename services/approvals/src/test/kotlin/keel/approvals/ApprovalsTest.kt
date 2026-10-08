/**
 * The approvals service as it runs: Spring Boot on a random port, the real Postgres the other suites use, the real
 * relay and idempotency tables. What is asserted is what the fleet relies on: a keyed command runs once, a decision
 * is one person's and happens once, an event crosses the relay in the shared format, and an event raised elsewhere
 * changes rows here and wakes the live queries open on this instance.
 */
package keel.approvals

import dev.rayfold.core.Change
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.RelayMessage
import dev.rayfold.jdbc.PgNotifications
import dev.rayfold.jdbc.PgRelay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.Timeout
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.sql.DriverManager
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import javax.sql.DataSource
import kotlin.concurrent.withLock
import kotlin.test.assertEquals
import kotlin.test.assertNull

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
// every wait inside is bounded; this bounds what is not, such as a socket to a database that stopped answering
@Timeout(60)
class ApprovalsTest {
    companion object {
        /** The tests' database, as the TypeScript suites name it, so one Postgres serves every suite in the repository. */
        val DATABASE_URL: String = System.getenv("TEST_DATABASE_URL") ?: "postgres://postgres:rayfold@127.0.0.1:55432/apps_test"

        @JvmStatic
        @DynamicPropertySource
        fun fleet(registry: DynamicPropertyRegistry) {
            ensureDatabase()
            registry.add("keel.database-url") { DATABASE_URL }
            registry.add("keel.ops-token") { "test-ops-token" }
            registry.add("keel.instance") { "approvals-test" }
            registry.add("keel.version") { "test" }
        }

        private fun jdbc(url: String): Triple<String, String, String> {
            val uri = URI(url)
            val (user, password) = (uri.userInfo ?: "postgres:").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
            // a database that accepts the socket and never answers fails the connect instead of hanging the suite
            return Triple("jdbc:postgresql://${uri.host}:${uri.port}${uri.path}?loginTimeout=10", user, password)
        }

        private val databaseName: String get() = URI(DATABASE_URL).path.trimStart('/')

        /** The maintenance database: where a database is created from, and told to refuse connections. */
        private fun admin(block: (java.sql.Connection) -> Unit) {
            val (url, user, password) = jdbc(DATABASE_URL.replace("/$databaseName", "/postgres"))
            DriverManager.getConnection(url, user, password).use(block)
        }

        /** Created if it is not there, so the suite needs nothing beyond a reachable Postgres, like the others. */
        private fun ensureDatabase() = admin { c ->
            c.prepareStatement("select 1 from pg_database where datname = ?").use { s ->
                s.setString(1, databaseName)
                if (!s.executeQuery().next()) c.createStatement().use { it.execute("create database \"$databaseName\"") }
            }
        }
    }

    /**
     * What arrived from another thread, and a bounded wait on it that wakes the moment something arrives: the relay's
     * listener and the change bus both call [add], so a test waits on the event itself rather than polling for it.
     */
    private class Heard<T> {
        private val lock = ReentrantLock()
        private val arrived = lock.newCondition()
        private val seen = ArrayList<T>()

        fun add(item: T) = lock.withLock { seen.add(item); arrived.signalAll() }
        fun clear() = lock.withLock { seen.clear() }
        fun all(): List<T> = lock.withLock { seen.toList() }

        fun <R : Any> await(what: String, pick: (List<T>) -> R?): R {
            lock.lock()
            try {
                var left = TimeUnit.SECONDS.toNanos(5)
                while (true) {
                    pick(seen.toList())?.let { return it }
                    if (left <= 0) throw AssertionError("still waiting for $what after 5000ms; heard $seen")
                    left = arrived.awaitNanos(left)
                }
            } finally {
                lock.unlock()
            }
        }
    }

    @LocalServerPort
    var port: Int = 0

    @Autowired
    lateinit var dataSource: DataSource

    @Autowired
    lateinit var server: RayfoldServer

    private val http = HttpClient.newHttpClient()
    private val json = Json { ignoreUnknownKeys = true }

    /** Another member of the fleet, as far as the relay can tell: hears what this service publishes, and publishes to it. */
    private lateinit var other: PgRelay
    private val heard = Heard<RelayMessage>()
    private lateinit var stopHearing: suspend () -> Unit

    /** What this instance's live queries hear: every command's change, and the rows an event from elsewhere changed. */
    private val changes = Heard<Change>()
    private lateinit var stopWatching: () -> Unit

    @BeforeAll
    fun listen() {
        val (url, user, password) = jdbc(DATABASE_URL)
        other = PgRelay(PgNotifications(DriverManager.getConnection(url, user, password), { DriverManager.getConnection(url, user, password) }), { DriverManager.getConnection(url, user, password) })
        stopHearing = runBlocking { other.subscribe { heard.add(it) } }
        assertEquals(0, server.changes.size)
        stopWatching = server.changes.subscribe { changes.add(it) }
    }

    @AfterAll
    fun stop() {
        runBlocking { stopHearing() }
        stopWatching()
        assertEquals(0, server.changes.size)
    }

    @BeforeEach
    fun reset() {
        dataSource.connection.use { c -> c.createStatement().use { it.execute("truncate approvals, rayfold_idempotency, rayfold_relay") } }
        heard.clear()
        changes.clear()
    }

    /** Nothing a test did is left subscribed: the only listener on the bus is this suite's own. */
    @AfterEach
    fun nothingLeftOpen() {
        assertEquals(1, server.changes.size)
    }

    private fun post(who: String, vararg ops: JsonObject): HttpRequest =
        HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold"))
            .header("authorization", "Bearer $who")
            .header("content-type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(buildJsonObject { put("ops", JsonArray(ops.toList())) }.toString()))
            .build()

    private fun framesOf(res: HttpResponse<String>): List<JsonObject> {
        assertEquals(200, res.statusCode(), res.body())
        return res.body().lines().filter { it.isNotBlank() }.map { json.parseToJsonElement(it).jsonObject }
    }

    private fun batch(who: String, vararg ops: JsonObject): List<JsonObject> = framesOf(http.send(post(who, *ops), HttpResponse.BodyHandlers.ofString()))

    /** A member of an answer, or a failure that says what the answer was instead. */
    private fun JsonObject.at(key: String): JsonElement = this[key] ?: throw AssertionError("no \"$key\" in $this")
    private fun JsonObject.obj(key: String): JsonObject = at(key).jsonObject
    private fun JsonObject.text(key: String): String = at(key).jsonPrimitive.content
    private fun JsonObject.ids(): List<String> = at("data").jsonArray.map { it.jsonObject.text("id") }

    private fun approval(id: String, shape: String = "{ stale decision note }"): JsonObject = one("grace", "approval", buildJsonObject { put("id", id) }, shape).obj("data")
    private fun inboxOf(who: String): List<String> = one(who, "inbox", buildJsonObject {}, "{ id }").ids()
    private fun onDocument(documentId: String): List<String> = one("ada", "approvals", buildJsonObject { put("documentId", documentId) }, "{ id }").ids()
    private fun events(name: String): List<JsonObject> = heard.all().filterIsInstance<RelayMessage.Event>().filter { it.name == name }.map { it.payload }
    private fun awaitEvent(name: String, which: (JsonObject) -> Boolean = { true }): JsonObject =
        heard.await("the relay to carry $name") { all -> all.filterIsInstance<RelayMessage.Event>().firstOrNull { it.name == name && which(it.payload) }?.payload }

    /** The change a live query on this instance hears that names [key]. */
    private fun awaitChange(key: String): Change = changes.await("a change naming $key") { all -> all.firstOrNull { key in it.keys } }

    private fun op(id: Int, op: String, args: JsonObject, shape: String, key: String? = null) = buildJsonObject {
        put("id", id); put("op", op); put("args", args); put("shape", shape)
        if (key != null) put("key", key)
    }

    private fun one(who: String, op: String, args: JsonObject, shape: String, key: String? = null): JsonObject {
        val frames = batch(who, op(1, op, args, shape, key))
        return frames.first { it.containsKey("data") || it.containsKey("ok") || it.containsKey("error") }
    }

    private fun command(who: String, op: String, args: JsonObject, shape: String = "{ id }"): JsonObject = one(who, op, args, shape, UUID.randomUUID().toString())

    private fun ask(who: String = "ada", approver: String = "u2", documentId: String = "d1", version: Int = 1, key: String = UUID.randomUUID().toString()): JsonObject =
        one(who, "requestApproval", buildJsonObject { put("documentId", documentId); put("projectId", "p1"); put("documentName", "MSA v3.pdf"); put("version", version); put("approverId", approver) }, "{ id decision stale requester { name } approver { name } }", key).obj("ok")

    /** The documents service's event; `revision` false is a new name on the same bytes, null a publisher without the field. */
    private fun kept(documentId: String, version: Int, revision: Boolean? = null) = runBlocking {
        other.publish(RelayMessage.Event("DocumentChanged", buildJsonObject { put("documentId", documentId); put("projectId", "p1"); put("name", "MSA v3.pdf"); put("version", version); put("byId", "u1"); if (revision != null) put("revision", revision) }))
    }

    /** One column of one row, as the table holds it. */
    private fun column(id: String, name: String): Any? = dataSource.connection.use { c ->
        c.prepareStatement("select $name from approvals where id = ?").use { s ->
            s.setString(1, id)
            s.executeQuery().use { rs -> if (rs.next()) rs.getObject(1) else throw AssertionError("no approval $id") }
        }
    }

    private fun instant(millis: Any?): String = Instant.ofEpochMilli((millis as Number).toLong()).toString()


    @Test
    fun `a sign-off is asked of one person, sits in their inbox, and is decided by them once`() {
        val asked = ask()
        assertEquals("pending", asked.text("decision"))
        assertEquals("Ada Lovelace", asked.obj("requester").text("name"))
        assertEquals("Grace Hopper", asked.obj("approver").text("name"))
        val id = asked.text("id")
        // what the workspace builds its feed line and its bell from: all of it is the contract
        assertEquals(
            buildJsonObject { put("approvalId", id); put("documentId", "d1"); put("projectId", "p1"); put("documentName", "MSA v3.pdf"); put("requesterId", "u1"); put("approverId", "u2") },
            awaitEvent("ApprovalRequested"),
        )

        // in Grace's inbox and nobody else's
        assertEquals(listOf(id), inboxOf("grace"))
        assertEquals(emptyList(), inboxOf("ada"))

        // not Ada's to decide; Grace's, once
        assertEquals("NotYours", command("ada", "decide", buildJsonObject { put("id", id); put("decision", "approved") }).obj("error").text("type"))
        val decided = command("grace", "decide", buildJsonObject { put("id", id); put("decision", "approved"); put("note", "Clause 3 is fine.") }, "{ decision note askedAt decidedAt }").obj("ok")
        assertEquals("approved", decided.text("decision"))
        assertEquals("Clause 3 is fine.", decided.text("note"))
        // what was answered is what was kept: the times are the table's, as RFC 3339
        assertEquals(instant(column(id, "decided_at")), decided.text("decidedAt"))
        assertEquals(instant(column(id, "asked_at")), decided.text("askedAt"))
        assertEquals(
            listOf("approved", "Clause 3 is fine.", decided.text("askedAt"), decided.text("decidedAt")),
            approval(id, "{ decision note askedAt decidedAt }").let { listOf(it.text("decision"), it.text("note"), it.text("askedAt"), it.text("decidedAt")) },
        )
        assertEquals(
            buildJsonObject {
                put("approvalId", id); put("documentId", "d1"); put("projectId", "p1"); put("documentName", "MSA v3.pdf")
                put("decision", "approved"); put("byId", "u2"); put("note", "Clause 3 is fine.")
            },
            awaitEvent("ApprovalDecided"),
        )
        val again = command("grace", "decide", buildJsonObject { put("id", id); put("decision", "declined") }).obj("error")
        assertEquals("AlreadyDecided", again.text("type"))
        assertEquals("approved", again.obj("data").text("decision"))
        // and the one who asked cannot take back what is decided
        assertEquals("AlreadyDecided", command("ada", "withdraw", buildJsonObject { put("id", id) }).obj("error").text("type"))
        assertEquals(emptyList(), inboxOf("grace"))

        // guard: asking yourself is refused, and nothing was written
        assertEquals("NotYours", command("ada", "requestApproval", buildJsonObject { put("documentId", "d2"); put("projectId", "p1"); put("documentName", "x"); put("version", 1); put("approverId", "u1") }).obj("error").text("type"))
        assertEquals(emptyList(), onDocument("d2"))
    }

    @Test
    fun `a document's sign-offs read newest first, an inbox oldest first, each with the version it was asked about`() {
        val older = ask(version = 2).text("id")
        val newer = ask(version = 3).text("id")
        val elsewhere = ask(documentId = "d2").text("id")
        // two asked within one millisecond would tie: the times are set so the order is the one under test
        dataSource.connection.use { c ->
            c.prepareStatement("update approvals set asked_at = ? where id = ?").use { s ->
                for ((at, id) in listOf(1_000L to older, 2_000L to newer, 3_000L to elsewhere)) { s.setLong(1, at); s.setString(2, id); s.executeUpdate() }
            }
        }
        assertEquals(listOf(newer, older), onDocument("d1"))
        assertEquals(listOf(older, newer, elsewhere), inboxOf("grace"))
        assertEquals(listOf("2", "1970-01-01T00:00:01Z"), approval(older, "{ version askedAt }").let { listOf(it.text("version"), it.text("askedAt")) })
        assertEquals("3", approval(newer, "{ version }").text("version"))
        // a decided one leaves the inbox and stays on the document
        command("grace", "decide", buildJsonObject { put("id", older); put("decision", "declined"); put("note", "No.") })
        assertEquals(listOf(newer, elsewhere), inboxOf("grace"))
        assertEquals(listOf(newer, older), onDocument("d1"))
    }

    @Test
    fun `a keyed command retried runs once - the record is in the table the whole fleet shares`() {
        val key = UUID.randomUUID().toString()
        val first = ask(key = key)
        val second = ask(key = key)
        assertEquals(first.text("id"), second.text("id"))
        assertEquals(listOf(first.text("id")), onDocument("d1"))
        dataSource.connection.use { c ->
            c.createStatement().use { s -> s.executeQuery("select count(*) from rayfold_idempotency").use { it.next(); assertEquals(1, it.getInt(1)) } }
        }
    }

    @Test
    fun `a command wakes the live queries that read what it changed, here and on every other instance`() {
        val id = ask().text("id")
        // a new row: every open list of the document's sign-offs and the approver's inbox re-run
        assertEquals(Change(setOf("Approval:$id"), setOf("approvals", "inbox")), awaitChange("Approval:$id"))
        // and the other instances hear the same change over the relay
        val relayed = heard.await("the relay to carry the change") { all -> all.filterIsInstance<RelayMessage.Change>().firstOrNull { "Approval:$id" in it.keys } }
        assertEquals(setOf("approvals", "inbox") to setOf("Approval:$id"), relayed.ops to relayed.keys)

        changes.clear()
        command("grace", "decide", buildJsonObject { put("id", id); put("decision", "approved") })
        // the row itself changed, and it left the inbox; the document's list holds it still, and hears it by its key
        assertEquals(Change(setOf("Approval:$id"), setOf("inbox")), awaitChange("Approval:$id"))

        val withdrawn = ask().text("id")
        changes.clear()
        command("ada", "withdraw", buildJsonObject { put("id", withdrawn) })
        assertEquals(Change(setOf("Approval:$withdrawn"), setOf("inbox")), awaitChange("Approval:$withdrawn"))
    }

    @Test
    fun `a new name on the same bytes leaves a pending sign-off as it is, and new bytes make it stale`() {
        val id = ask().text("id")
        awaitEvent("ApprovalRequested")
        changes.clear()
        kept("d1", 2, revision = false)
        // nothing to wait on for an event that changes nothing, so the next one, which does, says the first was handled
        val sentinel = ask(documentId = "d3", version = 1).text("id")
        changes.clear()
        kept("d3", 2, revision = true)
        assertEquals(Change(setOf("Approval:$sentinel"), setOf("approvals", "inbox")), awaitChange("Approval:$sentinel"))
        assertEquals(false, column(id, "stale"))
        // guard: the same document's new bytes do make it stale
        changes.clear()
        kept("d1", 3, revision = true)
        assertEquals(Change(setOf("Approval:$id"), setOf("approvals", "inbox")), awaitChange("Approval:$id"))
        assertEquals(true, column(id, "stale"))
    }

    @Test
    fun `what the documents service raises marks older pending sign-offs stale, and wakes this instance's live queries`() {
        val id = ask().text("id")
        awaitEvent("ApprovalRequested")
        changes.clear()

        // the documents service keeps version 2: raised in TypeScript on another port, it reaches here the same way
        kept("d1", 2)
        // the rows are local, and every instance heard the same event: delivered here, not published again
        assertEquals(Change(setOf("Approval:$id"), setOf("approvals", "inbox")), awaitChange("Approval:$id"))
        assertEquals(listOf("true", "pending"), approval(id).let { listOf(it.text("stale"), it.text("decision")) })
        assertEquals(true, column(id, "stale"))

        // guard: a sign-off on the newer version is not stale, nor is one on another document; one already stale is not
        // named again. the event marks every pending one on an older version in one statement, so the one asked on
        // version 1 since then turning stale says this event has been handled
        val fresh = ask(documentId = "d1", version = 2).text("id")
        val otherDocument = ask(documentId = "d2", version = 1).text("id")
        val sentinel = ask(documentId = "d1", version = 1).text("id")
        changes.clear()
        kept("d1", 2)
        assertEquals(Change(setOf("Approval:$sentinel"), setOf("approvals", "inbox")), awaitChange("Approval:$sentinel"))
        assertEquals(listOf("false", "false"), listOf(approval(fresh).text("stale"), approval(otherDocument).text("stale")))

        // and a decided one is left alone by a later version: it was decided on what it was asked about
        val settled = ask(documentId = "d1", version = 2).text("id")
        assertEquals("approved", command("grace", "decide", buildJsonObject { put("id", settled); put("decision", "approved") }, "{ decision }").obj("ok").text("decision"))
        changes.clear()
        kept("d1", 3)
        assertEquals(Change(setOf("Approval:$fresh"), setOf("approvals", "inbox")), awaitChange("Approval:$fresh"))
        assertEquals(listOf("approved", "false"), approval(settled).let { listOf(it.text("decision"), it.text("stale")) })

        // an event that names no version changes nothing: a request asked after it is the next change this instance hears
        runBlocking { other.publish(RelayMessage.Event("DocumentChanged", buildJsonObject { put("documentId", "d2"); put("projectId", "p1"); put("name", "x"); put("byId", "u1") })) }
        changes.clear()
        val after = ask(documentId = "d3").text("id")
        awaitChange("Approval:$after")
        assertEquals(listOf(setOf("Approval:$after")), changes.all().map { it.keys })
        assertEquals("false", approval(otherDocument).text("stale"))
        // guard: the same event with a version does mark it
        kept("d2", 2)
        awaitChange("Approval:$otherDocument")

        // nothing delivered here went back onto the relay: what the other instances heard is the commands' changes only
        heard.await("the relay to carry the last request's change") { all -> all.filterIsInstance<RelayMessage.Change>().firstOrNull { "Approval:$after" in it.keys } }
        val relayedKeys = heard.all().filterIsInstance<RelayMessage.Change>().flatMap { it.keys }.toSet()
        assertEquals(setOf("Approval:$id", "Approval:$fresh", "Approval:$otherDocument", "Approval:$sentinel", "Approval:$settled", "Approval:$after"), relayedKeys)
        assertEquals(1, heard.all().filterIsInstance<RelayMessage.Change>().count { "Approval:$sentinel" in it.keys })

        // one that went stale while pending can still be decided, and says it was stale
        assertEquals("true", command("grace", "decide", buildJsonObject { put("id", id); put("decision", "approved") }, "{ stale }").obj("ok").text("stale"))
    }

    @Test
    fun `says who it is behind the ops token, and answers readiness by asking the database`() {
        val stats = http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold/stats")).header("authorization", "Bearer test-ops-token").GET().build(), HttpResponse.BodyHandlers.ofString())
        assertEquals(200, stats.statusCode(), stats.body())
        val identity = json.parseToJsonElement(stats.body()).jsonObject.obj("identity")
        assertEquals(listOf("approvals", "approvals-test", "test"), listOf(identity.text("name"), identity.text("instance"), identity.text("version")))
        // configured, so a missing or wrong token is refused rather than hidden
        assertEquals(403, http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold/stats")).GET().build(), HttpResponse.BodyHandlers.ofString()).statusCode())
        assertEquals(403, http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold/stats")).header("authorization", "Bearer test-ops-tokenx").GET().build(), HttpResponse.BodyHandlers.ofString()).statusCode())

        val ready = { http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold/ready")).GET().build(), HttpResponse.BodyHandlers.ofString()) }
        val up = ready()
        assertEquals(200 to buildJsonObject { put("ready", true); put("reasons", buildJsonArray {}) }, up.statusCode() to json.parseToJsonElement(up.body()))
        // the database refusing new connections makes this instance not ready, and says which check failed. the relay's
        // listener keeps the connection it already holds, so the database is the only reason
        admin { c -> c.createStatement().use { it.execute("alter database \"$databaseName\" allow_connections false") } }
        try {
            val down = ready()
            assertEquals(503, down.statusCode(), down.body())
            val reasons = json.parseToJsonElement(down.body()).jsonObject.at("reasons").jsonArray.map { it.jsonPrimitive.content }
            assertEquals(listOf("db"), reasons.map { it.substringBefore(":") }, reasons.toString())
        } finally {
            admin { c -> c.createStatement().use { it.execute("alter database \"$databaseName\" allow_connections true") } }
        }
        assertEquals(200, ready().statusCode())
    }

    @Test
    fun `a browser's cookie is the same person as a bearer handle, and nobody may ask`() {
        val forGrace = ask(approver = "u2").text("id")
        val forNoor = ask(approver = "u3").text("id")
        // what a browser sends: the session cookie among others, and no Authorization header. the inbox is the caller's
        // own, so the answer says whom the request was read as
        fun inboxAs(vararg headers: Pair<String, String>): JsonObject {
            val request = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold")).header("content-type", "application/json")
            for ((k, v) in headers) request.header(k, v)
            val body = buildJsonObject { put("ops", JsonArray(listOf(op(1, "inbox", buildJsonObject {}, "{ id }")))) }.toString()
            return framesOf(http.send(request.POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString())).first { it.containsKey("data") || it.containsKey("error") }
        }
        assertEquals(listOf(forGrace), inboxAs("cookie" to "keel_session=grace").ids())
        assertEquals(listOf(forGrace), inboxAs("cookie" to "theme=dark; keel_session=grace; lang=en").ids())
        assertEquals(listOf(forGrace), inboxAs("cookie" to "xkeel_session=noor; keel_session=grace").ids())
        // the value is decoded as a browser encodes it
        assertEquals(listOf(forNoor), inboxAs("cookie" to "keel_session=%6Eoor").ids())
        // a program's bearer is who it says, whatever cookie came with it
        assertEquals(listOf(forGrace), inboxAs("authorization" to "Bearer grace", "cookie" to "keel_session=noor").ids())
        // guard: the same handle as a bearer is the same person, and another's inbox is theirs
        assertEquals(listOf(forGrace), inboxOf("grace"))
        assertEquals(listOf(forNoor), inboxOf("noor"))

        // nobody: an unknown handle, a handle that is not a bearer, a cookie of another name
        for (headers in listOf(arrayOf("authorization" to "Bearer nobody"), arrayOf("authorization" to "grace"), arrayOf("cookie" to "not_keel_session=grace"), arrayOf("cookie" to "xkeel_session=grace"))) {
            val nobody = inboxAs(*headers)
            assertEquals("unauthenticated", nobody.obj("error").text("code"), headers.toList().toString())
            assertNull(nobody["data"])
        }
    }

    @Test
    fun `the one who asked may take it back, and nobody else may`() {
        val id = ask().text("id")
        // not Grace's to withdraw: she was asked, she did not ask
        assertEquals("NotYours", command("grace", "withdraw", buildJsonObject { put("id", id) }).obj("error").text("type"))
        assertEquals(listOf(id), inboxOf("grace"))

        val withdrawn = command("ada", "withdraw", buildJsonObject { put("id", id) }, "{ decision note }").obj("ok")
        assertEquals(buildJsonObject { put("\$type", "Approval"); put("decision", "withdrawn"); put("note", JsonNull) }, withdrawn)
        assertEquals(emptyList(), inboxOf("grace"))
        assertEquals(
            buildJsonObject {
                put("approvalId", id); put("documentId", "d1"); put("projectId", "p1"); put("documentName", "MSA v3.pdf")
                put("decision", "withdrawn"); put("byId", "u1"); put("note", JsonNull)
            },
            awaitEvent("ApprovalDecided"),
        )
        assertEquals("NotFound", command("ada", "withdraw", buildJsonObject { put("id", "no-such-sign-off") }).obj("error").text("type"))
    }

    @Test
    fun `a decision is approved or declined, and nothing else`() {
        val id = ask().text("id")
        // a Decision the schema knows, but not one the person asked may give: the resolver refuses it
        assertEquals("invalid_argument", command("grace", "decide", buildJsonObject { put("id", id); put("decision", "withdrawn") }).obj("error").text("code"))
        // one the schema does not know is refused before any resolver runs
        assertEquals("invalid_argument", command("grace", "decide", buildJsonObject { put("id", id); put("decision", "maybe") }).obj("error").text("code"))
        assertEquals("pending", approval(id).text("decision"))
        assertEquals(listOf(id), inboxOf("grace"))

        // guard: declined is a decision, with its reason
        val declined = command("grace", "decide", buildJsonObject { put("id", id); put("decision", "declined"); put("note", "Not yet.") }, "{ decision note }").obj("ok")
        assertEquals(listOf("declined", "Not yet."), listOf(declined.text("decision"), declined.text("note")))
        assertEquals(listOf("declined", "Not yet."), approval(id).let { listOf(it.text("decision"), it.text("note")) })
        assertEquals("NotFound", command("grace", "decide", buildJsonObject { put("id", "no-such-sign-off"); put("decision", "approved") }).obj("error").text("type"))
    }

    @Test
    fun `a sign-off cannot be asked of someone who is not on the team`() {
        // u99 is no one; "grace" is a handle, not an id
        for (approver in listOf("u99", "grace")) {
            val refused = command("ada", "requestApproval", buildJsonObject { put("documentId", "d1"); put("projectId", "p1"); put("documentName", "MSA v3.pdf"); put("version", 1); put("approverId", approver) }).obj("error")
            assertEquals(listOf("domain", "NotFound"), listOf(refused.text("code"), refused.text("type")))
            assertEquals(buildJsonObject { put("id", approver) }, refused.obj("data"))
        }
        assertEquals(emptyList(), onDocument("d1"))

        // guard: someone who is on it can be asked
        assertEquals("Noor Haddad", ask(approver = "u3").obj("approver").text("name"))
    }

    @Test
    fun `two decisions at once - the one that lands second is told what the first was, and changes nothing`() {
        val id = ask().text("id")
        dataSource.connection.use { first ->
            // another instance's decision, holding the row. the second reads the sign-off as pending, passes every
            // check, and reaches its write while the first is still open
            first.autoCommit = false
            first.prepareStatement("update approvals set decision = 'declined', note = 'Not yet.', decided_at = 1 where id = ?").use { it.setString(1, id); it.executeUpdate() }
            val second = http.sendAsync(post("grace", op(1, "decide", buildJsonObject { put("id", id); put("decision", "approved") }, "{ decision }", UUID.randomUUID().toString())), HttpResponse.BodyHandlers.ofString())
            // nothing announces a statement blocked on a row lock, so this one wait asks, on one connection, until it is
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            dataSource.connection.use { c ->
                c.prepareStatement("select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'update approvals set decision = %'").use { s ->
                    while (s.executeQuery().use { rs -> !(rs.next() && rs.getInt(1) == 1) }) {
                        if (System.nanoTime() > deadline) throw AssertionError("still waiting for the second decision to wait on the first after 5000ms")
                    }
                }
            }
            first.commit()
            val refused = framesOf(second.get(5, TimeUnit.SECONDS)).first { it.containsKey("ok") || it.containsKey("error") }.obj("error")
            assertEquals(listOf("AlreadyDecided", "declined"), listOf(refused.text("type"), refused.obj("data").text("decision")))
        }
        // the first decision stands
        assertEquals(listOf("declined", "Not yet."), approval(id).let { listOf(it.text("decision"), it.text("note")) })
        // and the second raised nothing: a sign-off asked afterwards reaches the relay with no decision before it
        ask(documentId = "d2")
        awaitEvent("ApprovalRequested") { it["documentId"] == JsonPrimitive("d2") }
        assertEquals(emptyList(), events("ApprovalDecided"))
    }
}
