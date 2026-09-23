/**
 * The approvals service as it runs: Spring Boot on a random port, the real Postgres the other suites use, the real
 * relay and idempotency tables. What is asserted is what the fleet relies on: a keyed command runs once, a decision
 * is one person's and happens once, an event crosses the relay in the shared format, and an event raised elsewhere
 * changes rows here.
 */
package keel.approvals

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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
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
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import javax.sql.DataSource
import kotlin.test.assertEquals
import kotlin.test.assertNull

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
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
        }

        private fun jdbc(url: String): Triple<String, String, String> {
            val uri = URI(url)
            val (user, password) = (uri.userInfo ?: "postgres:").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
            return Triple("jdbc:postgresql://${uri.host}:${uri.port}${uri.path}", user, password)
        }

        /** Created if it is not there, so the suite needs nothing beyond a reachable Postgres, like the others. */
        private fun ensureDatabase() {
            val name = URI(DATABASE_URL).path.trimStart('/')
            val (url, user, password) = jdbc(DATABASE_URL.replace("/$name", "/postgres"))
            DriverManager.getConnection(url, user, password).use { c ->
                c.prepareStatement("select 1 from pg_database where datname = ?").use { s ->
                    s.setString(1, name)
                    if (!s.executeQuery().next()) c.createStatement().use { it.execute("create database \"$name\"") }
                }
            }
        }
    }

    @LocalServerPort
    var port: Int = 0

    @Autowired
    lateinit var dataSource: DataSource

    private val http = HttpClient.newHttpClient()
    private val json = Json { ignoreUnknownKeys = true }

    /** Another member of the fleet, as far as the relay can tell: hears what this service publishes, and publishes to it. */
    private lateinit var other: PgRelay
    private val heard = CopyOnWriteArrayList<RelayMessage>()
    private lateinit var stopHearing: suspend () -> Unit

    @BeforeAll
    fun listen() {
        val (url, user, password) = jdbc(DATABASE_URL)
        other = PgRelay(PgNotifications(DriverManager.getConnection(url, user, password), { DriverManager.getConnection(url, user, password) }), { DriverManager.getConnection(url, user, password) })
        stopHearing = runBlocking { other.subscribe { heard.add(it) } }
    }

    @AfterAll
    fun stop() {
        runBlocking { stopHearing() }
    }

    @BeforeEach
    fun reset() {
        dataSource.connection.use { c -> c.createStatement().use { it.execute("truncate approvals, rayfold_idempotency, rayfold_relay") } }
        heard.clear()
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

    private fun approval(id: String): JsonObject = one("grace", "approval", buildJsonObject { put("id", id) }, "{ stale decision note }").obj("data")
    private fun inboxOf(who: String): List<String> = one(who, "inbox", buildJsonObject {}, "{ id }").at("data").jsonArray.map { it.jsonObject.text("id") }
    private fun decidedEvents(): List<JsonObject> = heard.filterIsInstance<RelayMessage.Event>().filter { it.name == "ApprovalDecided" }.map { it.payload }

    private fun op(id: Int, op: String, args: JsonObject, shape: String, key: String? = null) = buildJsonObject {
        put("id", id); put("op", op); put("args", args); put("shape", shape)
        if (key != null) put("key", key)
    }

    private fun one(who: String, op: String, args: JsonObject, shape: String, key: String? = null): JsonObject {
        val frames = batch(who, op(1, op, args, shape, key))
        return frames.first { it.containsKey("data") || it.containsKey("ok") || it.containsKey("error") }
    }

    private fun ask(who: String = "ada", approver: String = "u2", documentId: String = "d1", version: Int = 1, key: String = UUID.randomUUID().toString()): JsonObject =
        one(who, "requestApproval", buildJsonObject { put("documentId", documentId); put("projectId", "p1"); put("documentName", "MSA v3.pdf"); put("version", version); put("approverId", approver) }, "{ id decision stale requester { name } approver { name } }", key)["ok"]!!.jsonObject

    private fun <T> until(what: String, check: () -> T?): T {
        val deadline = System.currentTimeMillis() + 5_000
        while (true) {
            check()?.let { return it }
            if (System.currentTimeMillis() > deadline) throw AssertionError("still waiting for $what after 5000ms")
            Thread.sleep(25)
        }
    }

    @Test
    fun `a sign-off is asked of one person, sits in their inbox, and is decided by them once`() {
        val asked = ask()
        assertEquals("pending", asked["decision"]!!.jsonPrimitive.content)
        assertEquals("Ada Lovelace", asked["requester"]!!.jsonObject["name"]!!.jsonPrimitive.content)
        assertEquals("Grace Hopper", asked["approver"]!!.jsonObject["name"]!!.jsonPrimitive.content)
        val id = asked["id"]!!.jsonPrimitive.content

        // in Grace's inbox and nobody else's
        assertEquals(listOf(id), one("grace", "inbox", buildJsonObject {}, "{ id }")["data"]!!.jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.content })
        assertEquals(0, one("ada", "inbox", buildJsonObject {}, "{ id }")["data"]!!.jsonArray.size)

        // not Ada's to decide; Grace's, once
        val notYours = one("ada", "decide", buildJsonObject { put("id", id); put("decision", "approved") }, "{ id }", UUID.randomUUID().toString())["error"]!!.jsonObject
        assertEquals("NotYours", notYours["type"]!!.jsonPrimitive.content)
        val decided = one("grace", "decide", buildJsonObject { put("id", id); put("decision", "approved"); put("note", "Clause 3 is fine.") }, "{ decision note decidedAt }", UUID.randomUUID().toString())["ok"]!!.jsonObject
        assertEquals("approved", decided["decision"]!!.jsonPrimitive.content)
        assertEquals("Clause 3 is fine.", decided["note"]!!.jsonPrimitive.content)
        // the workspace builds its feed line and its notification from this, so all of it is the contract
        val told = until("the relay to carry ApprovalDecided") { decidedEvents().firstOrNull() }
        assertEquals(
            buildJsonObject {
                put("approvalId", id); put("documentId", "d1"); put("projectId", "p1"); put("documentName", "MSA v3.pdf")
                put("decision", "approved"); put("byId", "u2"); put("note", "Clause 3 is fine.")
            },
            told,
        )
        val again = one("grace", "decide", buildJsonObject { put("id", id); put("decision", "declined") }, "{ id }", UUID.randomUUID().toString())["error"]!!.jsonObject
        assertEquals("AlreadyDecided", again["type"]!!.jsonPrimitive.content)
        assertEquals("approved", again["data"]!!.jsonObject["decision"]!!.jsonPrimitive.content)
        // and the one who asked cannot take back what is decided
        assertEquals("AlreadyDecided", one("ada", "withdraw", buildJsonObject { put("id", id) }, "{ id }", UUID.randomUUID().toString())["error"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals(0, one("grace", "inbox", buildJsonObject {}, "{ id }")["data"]!!.jsonArray.size)

        // guard: asking yourself is refused, and nothing was written
        assertEquals("NotYours", one("ada", "requestApproval", buildJsonObject { put("documentId", "d2"); put("projectId", "p1"); put("documentName", "x"); put("version", 1); put("approverId", "u1") }, "{ id }", UUID.randomUUID().toString())["error"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals(0, one("ada", "approvals", buildJsonObject { put("documentId", "d2") }, "{ id }")["data"]!!.jsonArray.size)
    }

    @Test
    fun `a keyed command retried runs once - the record is in the table the whole fleet shares`() {
        val key = UUID.randomUUID().toString()
        val first = ask(key = key)
        val second = ask(key = key)
        assertEquals(first["id"], second["id"])
        assertEquals(1, one("ada", "approvals", buildJsonObject { put("documentId", "d1") }, "{ id }")["data"]!!.jsonArray.size)
        dataSource.connection.use { c ->
            c.createStatement().use { s -> s.executeQuery("select count(*) from rayfold_idempotency").use { it.next(); assertEquals(1, it.getInt(1)) } }
        }
    }

    @Test
    fun `what happens here reaches the relay in the shared format, and what the documents service raises changes rows here`() {
        val asked = ask()
        val id = asked["id"]!!.jsonPrimitive.content
        // another member of the fleet hears the event, as the workspace does: by name, with the payload the schema declares
        val event = until("the relay to carry ApprovalRequested") { heard.filterIsInstance<RelayMessage.Event>().firstOrNull { it.name == "ApprovalRequested" } }
        assertEquals(id, event.payload["approvalId"]!!.jsonPrimitive.content)
        assertEquals("u2", event.payload["approverId"]!!.jsonPrimitive.content)

        // the documents service keeps version 2: raised in TypeScript on another port, it reaches here the same way
        runBlocking { other.publish(RelayMessage.Event("DocumentChanged", buildJsonObject { put("documentId", "d1"); put("projectId", "p1"); put("name", "MSA v3.pdf"); put("version", 2); put("byId", "u1") })) }
        val stale = until("the sign-off to be stale") {
            val a = one("grace", "approval", buildJsonObject { put("id", id) }, "{ stale decision }")["data"]!!.jsonObject
            if (a["stale"]!!.jsonPrimitive.content == "true") a else null
        }
        assertEquals("pending", stale["decision"]!!.jsonPrimitive.content)
        // guard: a sign-off on the newer version is not stale. the event marks every pending one on an older version
        // in one statement, so one asked on version 1 since then turning stale says this event has been handled
        val kept = { version: Int -> runBlocking { other.publish(RelayMessage.Event("DocumentChanged", buildJsonObject { put("documentId", "d1"); put("projectId", "p1"); put("name", "MSA v3.pdf"); put("version", version); put("byId", "u1") })) } }
        val fresh = ask(documentId = "d1", version = 2).text("id")
        val sentinel = ask(documentId = "d1", version = 1).text("id")
        kept(2)
        until("the sign-off on version 1 to be stale") { if (approval(sentinel).text("stale") == "true") true else null }
        assertEquals("false", approval(fresh).text("stale"))

        // and a decided one is left alone by a later version: it was decided on what it was asked about
        val settled = ask(documentId = "d1", version = 2).text("id")
        assertEquals("approved", one("grace", "decide", buildJsonObject { put("id", settled); put("decision", "approved") }, "{ decision }", UUID.randomUUID().toString()).obj("ok").text("decision"))
        kept(3)
        until("the pending sign-off on version 2 to be stale") { if (approval(fresh).text("stale") == "true") true else null }
        assertEquals(listOf("approved", "false"), approval(settled).let { listOf(it.text("decision"), it.text("stale")) })

        // one that went stale while pending can still be decided, and says it was stale
        val approved = one("grace", "decide", buildJsonObject { put("id", id); put("decision", "approved") }, "{ stale }", UUID.randomUUID().toString()).obj("ok")
        assertEquals("true", approved.text("stale"))
    }

    @Test
    fun `says who it is behind the ops token, and answers readiness`() {
        val stats = http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold/stats")).header("authorization", "Bearer test-ops-token").GET().build(), HttpResponse.BodyHandlers.ofString())
        assertEquals(200, stats.statusCode(), stats.body())
        val identity = json.parseToJsonElement(stats.body()).jsonObject["identity"]!!.jsonObject
        assertEquals("approvals", identity["name"]!!.jsonPrimitive.content)
        assertEquals("approvals-test", identity["instance"]!!.jsonPrimitive.content)
        assertEquals(403, http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold/stats")).GET().build(), HttpResponse.BodyHandlers.ofString()).statusCode()) // configured, so a wrong token is refused rather than hidden
        val ready = http.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold/ready")).GET().build(), HttpResponse.BodyHandlers.ofString())
        assertEquals(200, ready.statusCode(), ready.body())
    }

    @Test
    fun `a browser's cookie is the same person as a bearer handle, and nobody may ask`() {
        val forGrace = ask(approver = "u2").text("id")
        val forNoor = ask(approver = "u3").text("id")
        // what a browser sends: the session cookie, and no Authorization header. the inbox is the caller's own, so the
        // answer says whom the cookie was read as
        val res = http.send(
            HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold"))
                .header("cookie", "keel_session=grace")
                .header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(buildJsonObject { put("ops", JsonArray(listOf(op(1, "inbox", buildJsonObject {}, "{ id }")))) }.toString()))
                .build(),
            HttpResponse.BodyHandlers.ofString(),
        )
        val inbox = framesOf(res).first { it.containsKey("data") || it.containsKey("error") }.at("data").jsonArray.map { it.jsonObject.text("id") }
        assertEquals(listOf(forGrace), inbox)
        // guard: the same handle as a bearer is the same person, and another's inbox is theirs
        assertEquals(listOf(forGrace), inboxOf("grace"))
        assertEquals(listOf(forNoor), inboxOf("noor"))

        val nobody = one("nobody", "inbox", buildJsonObject {}, "{ id }")
        assertEquals("unauthenticated", nobody.obj("error").text("code"))
        assertNull(nobody["data"])
    }

    @Test
    fun `the one who asked may take it back, and nobody else may`() {
        val id = ask().text("id")
        // not Grace's to withdraw: she was asked, she did not ask
        assertEquals("NotYours", one("grace", "withdraw", buildJsonObject { put("id", id) }, "{ id }", UUID.randomUUID().toString()).obj("error").text("type"))
        assertEquals(listOf(id), inboxOf("grace"))

        val withdrawn = one("ada", "withdraw", buildJsonObject { put("id", id) }, "{ decision note }", UUID.randomUUID().toString()).obj("ok")
        assertEquals(buildJsonObject { put("\$type", "Approval"); put("decision", "withdrawn"); put("note", JsonNull) }, withdrawn)
        assertEquals(emptyList(), inboxOf("grace"))
        val told = until("the relay to carry the withdrawal") { decidedEvents().firstOrNull() }
        assertEquals(
            buildJsonObject {
                put("approvalId", id); put("documentId", "d1"); put("projectId", "p1"); put("documentName", "MSA v3.pdf")
                put("decision", "withdrawn"); put("byId", "u1"); put("note", JsonNull)
            },
            told,
        )
    }

    @Test
    fun `a decision is approved or declined, and nothing else`() {
        val id = ask().text("id")
        // a Decision the schema knows, but not one the person asked may give: the resolver refuses it
        assertEquals("invalid_argument", one("grace", "decide", buildJsonObject { put("id", id); put("decision", "withdrawn") }, "{ id }", UUID.randomUUID().toString()).obj("error").text("code"))
        // one the schema does not know is refused before any resolver runs
        assertEquals("invalid_argument", one("grace", "decide", buildJsonObject { put("id", id); put("decision", "maybe") }, "{ id }", UUID.randomUUID().toString()).obj("error").text("code"))
        assertEquals("pending", approval(id).text("decision"))
        assertEquals(listOf(id), inboxOf("grace"))

        // guard: declined is a decision
        assertEquals("declined", one("grace", "decide", buildJsonObject { put("id", id); put("decision", "declined") }, "{ decision }", UUID.randomUUID().toString()).obj("ok").text("decision"))
    }

    @Test
    fun `a sign-off cannot be asked of someone who is not on the team`() {
        val refused = one("ada", "requestApproval", buildJsonObject { put("documentId", "d1"); put("projectId", "p1"); put("documentName", "MSA v3.pdf"); put("version", 1); put("approverId", "u99") }, "{ id }", UUID.randomUUID().toString()).obj("error")
        assertEquals(listOf("domain", "NotFound"), listOf(refused.text("code"), refused.text("type")))
        assertEquals(buildJsonObject { put("id", "u99") }, refused.obj("data"))
        assertEquals(0, one("ada", "approvals", buildJsonObject { put("documentId", "d1") }, "{ id }").at("data").jsonArray.size)

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
            until("the second decision to wait on the first") {
                dataSource.connection.use { c ->
                    c.prepareStatement("select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'update approvals set decision = %'").use { s ->
                        s.executeQuery().use { rs -> if (rs.next() && rs.getInt(1) == 1) true else null }
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
        until("the relay to carry the later request") { heard.filterIsInstance<RelayMessage.Event>().firstOrNull { it.name == "ApprovalRequested" && it.payload["documentId"] == JsonPrimitive("d2") } }
        assertEquals(emptyList(), decidedEvents())
    }
}
