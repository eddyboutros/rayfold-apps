/**
 * signoff against the approvals service as it is deployed: its own jar, started as a process on a free port, against
 * the real Postgres the other suites use. Nothing stands in for the service, so what passes here is what the program
 * does to the real thing: typed results decoded from what the service sends, a live inbox over its socket, and
 * decisions that are one person's and happen once.
 *
 * Build the service first (cd services/approvals && ./mvnw package); CI runs this after the service's own tests.
 */
package keel.signoff

import dev.rayfold.client.HttpTransport
import dev.rayfold.client.RayfoldClient
import dev.rayfold.client.RayfoldClientException
import keel.signoff.api.Approval
import keel.signoff.api.Decision
import keel.signoff.api.Ops
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.Timeout
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.io.PrintStream
import java.net.ServerSocket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.sql.Connection
import java.sql.DriverManager
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.fail

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
// every wait inside is bounded; this bounds what is not, such as a socket to a database that stopped answering
@Timeout(60)
class SignOffTest {
    /** The tests' database, as every suite in the repository names it. */
    private val databaseUrl: String = System.getenv("TEST_DATABASE_URL") ?: "postgres://postgres:rayfold@127.0.0.1:55432/apps_test"
    private val jar = File("../../services/approvals/target/approvals-0.1.0.jar")
    private lateinit var service: Process
    private lateinit var base: String
    private val log = File("target/approvals-under-test.log")

    /** What every test here asks about, so a run leaves nothing behind for the next one. */
    private val documentPrefix = "signoff-test-"

    @BeforeAll
    fun start() {
        if (!jar.isFile) fail("${jar.path} is not built: cd services/approvals && ./mvnw package")
        val port = ServerSocket(0).use { it.localPort }
        base = "http://127.0.0.1:$port"
        log.parentFile.mkdirs()
        service = ProcessBuilder("java", "-jar", jar.absolutePath)
            .apply {
                environment()["PORT"] = port.toString()
                environment()["DATABASE_URL"] = databaseUrl
                environment()["INSTANCE"] = "approvals-signoff-test"
            }
            .redirectErrorStream(true)
            .start()
        // the service says when it is listening to the fleet, which is when it is ready; the wait is on that line, and
        // the log says why when it never comes
        val started = CompletableFuture<Boolean>()
        thread(isDaemon = true, name = "approvals-under-test") {
            log.bufferedWriter().use { w ->
                service.inputStream.bufferedReader().forEachLine { line ->
                    w.appendLine(line)
                    w.flush()
                    if ("[approvals] started" in line) started.complete(true)
                }
            }
            started.complete(false)
        }
        // a JVM and a Spring context: bounded
        val up = runCatching { started.get(60, TimeUnit.SECONDS) }.getOrDefault(false)
        if (!up) fail("the approvals service did not start; its log:\n${log.readText()}")
        val ready = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI("$base/rayfold/ready")).build(), HttpResponse.BodyHandlers.ofString())
        assertEquals(200, ready.statusCode(), ready.body())
    }

    @AfterAll
    fun stop() {
        if (::service.isInitialized) {
            service.destroy()
            if (!service.waitFor(10, TimeUnit.SECONDS)) service.destroyForcibly()
        }
    }

    private fun <T> database(block: (Connection) -> T): T {
        val uri = URI(databaseUrl)
        val (user, password) = (uri.userInfo ?: "postgres:").split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
        return DriverManager.getConnection("jdbc:postgresql://${uri.host}:${uri.port}${uri.path}?loginTimeout=10", user, password).use(block)
    }

    @AfterEach
    fun clean() {
        database { c -> c.prepareStatement("delete from approvals where document_id like ?").use { it.setString(1, "$documentPrefix%"); it.executeUpdate() } }
    }

    /** One column of one sign-off, as the service's table holds it. */
    private fun column(id: String, name: String): Any? = database { c ->
        c.prepareStatement("select $name from approvals where id = ?").use { s ->
            s.setString(1, id)
            s.executeQuery().use { rs -> if (rs.next()) rs.getObject(1) else fail("no approval $id") }
        }
    }

    /** Two asked within one millisecond would tie: the times are set so an order under test is the one asserted. */
    private fun askedAt(vararg ids: String) = database { c ->
        c.prepareStatement("update approvals set asked_at = ? where id = ?").use { s ->
            ids.forEachIndexed { i, id -> s.setLong(1, 1_000L * (i + 1)); s.setString(2, id); s.executeUpdate() }
        }
    }

    private fun instant(millis: Any?): String = Instant.ofEpochMilli((millis as Number).toLong()).toString()

    /** Ada asks someone to sign off on a document, as the documents panel does in a browser. */
    private suspend fun ask(approverId: String, name: String = "MSA v3.pdf"): String {
        val ada = RayfoldClient(HttpTransport("$base/rayfold", { mapOf("Authorization" to "Bearer ada") }))
        val args = json.encodeToJsonElement(Ops.RequestApprovalArgs("$documentPrefix${UUID.randomUUID()}", "p1", name, 3, approverId)).jsonObject
        val id = ada.command(Ops.REQUESTAPPROVAL, args, "{ id }").jsonObject["id"] ?: fail("requestApproval answered no id")
        return id.jsonPrimitive.content
    }

    private fun mine(list: List<Approval>) = list.filter { it.documentId.startsWith(documentPrefix) }

    /** What the program writes, a line at a time, as it writes it: a test waits on the next line rather than polling. */
    private class Lines : OutputStream() {
        private val pending = ByteArrayOutputStream()
        val lines = Channel<String>(Channel.UNLIMITED)

        override fun write(b: Int) {
            if (b == '\n'.code) {
                lines.trySend(pending.toString(Charsets.UTF_8).trimEnd('\r'))
                pending.reset()
            } else {
                pending.write(b)
            }
        }

        suspend fun next(): String = withTimeout(5_000) { lines.receive() }
    }

    @Test
    fun `the inbox is what is waiting on the person asking, decoded into the types generated from the schema`() = runBlocking {
        val first = ask("u4", "MSA v3.pdf")
        val second = ask("u4", "DPA annex.pdf")
        ask("u2", "Grace's one.pdf")
        askedAt(first, second)

        Desk(base, "tomas").use { desk ->
            val waiting = mine(desk.inbox())
            assertEquals(listOf(first, second), waiting.map { it.id })
            val msa = waiting.first()
            assertEquals(listOf("MSA v3.pdf", "p1"), listOf(msa.documentName, msa.projectId))
            assertEquals(3, msa.version)
            assertEquals(Decision.pending, msa.decision)
            assertEquals(false, msa.stale)
            assertEquals("u1" to "Ada Lovelace", msa.requester.id to msa.requester.name)
            assertEquals("u4" to "Tomás Ferreira", msa.approver.id to msa.approver.name)
            // an Instant arrives as RFC 3339, which is what the generated class holds it as: the time the table kept
            assertEquals("1970-01-01T00:00:01Z", msa.askedAt)
            assertEquals(null, msa.decidedAt)
        }
        // guard: someone else's inbox holds only what was asked of them
        Desk(base, "grace").use { assertEquals(listOf("Grace's one.pdf"), mine(it.inbox()).map { a -> a.documentName }) }
        // and a base written with its trailing slash is the same service
        Desk("$base/", "tomas").use { assertEquals(listOf(first, second), mine(it.inbox()).map { a -> a.id }) }
    }

    @Test
    fun `watching the inbox hears a request the moment it is asked, and a decision the moment it is made, over the service's socket`() = runBlocking {
        Desk(base, "tomas").use { desk ->
            val seen = Channel<List<Approval>>(Channel.UNLIMITED)
            val watching = launch { desk.watch().collect { seen.send(mine(it)) } }
            /** The next answer the service pushes that [holds]; nothing here asks again. */
            suspend fun next(holds: (List<Approval>) -> Boolean): List<Approval> = withTimeout(5_000) {
                var latest = seen.receive()
                while (!holds(latest)) latest = seen.receive()
                latest
            }
            try {
                assertEquals(emptyList(), withTimeout(5_000) { seen.receive() }.map { it.id })
                val id = ask("u4")
                assertEquals(listOf("MSA v3.pdf"), next { list -> list.any { it.id == id } }.map { it.documentName })
                // decided over HTTP, by the same person on another connection: it leaves the live inbox
                assertIs<Decided.Done>(desk.decide(id, Decision.approved, null))
                assertEquals(emptyList(), next { list -> list.none { it.id == id } })
            } finally {
                watching.cancelAndJoin()
            }
        }
    }

    @Test
    fun `a decision is the asked person's and happens once, a retry with its key replays, and a second decision is told the first`() = runBlocking {
        val id = ask("u4")
        // guard: not Grace's to decide
        Desk(base, "grace").use { assertEquals(Decided.NotYours, it.decide(id, Decision.approved, null)) }

        Desk(base, "tomas").use { desk ->
            // a refusal the schema does not declare is not an answer: it reaches the caller as the client's error
            val tooLong = assertFailsWith<RayfoldClientException> { desk.decide(id, Decision.approved, "x".repeat(1001)) }
            assertEquals("invalid_argument", tooLong.code)
            assertEquals(Decision.pending.name, column(id, "decision"))

            val key = UUID.randomUUID().toString()
            val approved = assertIs<Decided.Done>(desk.decide(id, Decision.approved, "Clause 3 is fine.", key))
            assertEquals(Decision.approved, approved.approval.decision)
            assertEquals("Clause 3 is fine.", approved.approval.note)
            assertEquals(instant(column(id, "decided_at")), approved.approval.decidedAt)
            // the same decision again with the same key, as a program that never heard the answer would send it: the
            // first answer, not a refusal, and nothing decided twice
            assertEquals(approved, desk.decide(id, Decision.approved, "Clause 3 is fine.", key))
            // a different decision is a different command, and it is refused with what was decided
            assertEquals(Decided.AlreadyDecided(Decision.approved), desk.decide(id, Decision.declined, "Changed my mind."))
            assertEquals(listOf("approved", "Clause 3 is fine."), listOf(column(id, "decision"), column(id, "note")))
            assertEquals(emptyList(), mine(desk.inbox()))
            assertEquals(Decided.NotFound, desk.decide("no-such-sign-off", Decision.approved, null))
        }
    }

    @Test
    fun `the program prints the inbox, decides from the command line, and says what it needs when it is not told`() = runBlocking {
        val env = mapOf("KEEL_USER" to "tomas", "KEEL_APPROVALS" to base)
        fun capture(args: List<String>, env: Map<String, String>): Pair<Int, String> = runBlocking {
            val out = ByteArrayOutputStream()
            val code = PrintStream(out, true, Charsets.UTF_8).use { run(args, env, it) }
            code to out.toString(Charsets.UTF_8).trim()
        }

        assertEquals(0 to "Nothing is waiting on you.", capture(listOf("inbox"), env))
        val id = ask("u4", "Supplier terms.pdf")
        val outdated = ask("u4", "Old terms.pdf")
        askedAt(id, outdated)
        database { c -> c.prepareStatement("update approvals set stale = true where id = ?").use { it.setString(1, outdated); it.executeUpdate() } }
        val (listed, inbox) = capture(listOf("inbox"), env)
        assertEquals(0, listed)
        assertEquals(
            listOf("$id  Supplier terms.pdf (v3), asked by Ada Lovelace", "$outdated  Old terms.pdf (v3), asked by Ada Lovelace - a newer version has been kept since"),
            inbox.lines().map { it.trimEnd('\r') },
        )

        // declining needs a reason, and either needs an id; without them nothing is sent
        assertEquals(2 to "Say why: signoff decline <id> <note>", capture(listOf("decline", id), env))
        assertEquals(2 to "Which one? signoff approve <id>", capture(listOf("approve"), env))
        assertEquals(listOf("pending", "pending"), listOf(column(id, "decision"), column(outdated, "decision")))

        // not Grace's, and nothing at all
        assertEquals(1 to "That one was not asked of you.", capture(listOf("approve", id), env + ("KEEL_USER" to "grace")))
        assertEquals(1 to "There is no sign-off nope.", capture(listOf("approve", "nope"), env))

        // the words after the id are the note, all of them
        assertEquals(0 to "declined: Supplier terms.pdf (v3)", capture(listOf("decline", id, "Liability", "cap", "missing."), env))
        assertEquals(listOf("declined", "Liability cap missing."), listOf(column(id, "decision"), column(id, "note")))
        assertEquals(1 to "Already declined: nothing changed.", capture(listOf("approve", id), env))
        // guard: approving needs no note, and approves
        assertEquals(0 to "approved: Old terms.pdf (v3)", capture(listOf("approve", outdated), env))
        assertEquals(listOf("approved", null), listOf(column(outdated, "decision"), column(outdated, "note")))

        // nobody, and nothing is asked of the service; a word it does not know, and it says what it knows
        val who = "Who are you? Set KEEL_USER to your handle on the team, e.g. KEEL_USER=tomas."
        assertEquals(2 to who, capture(listOf("inbox"), mapOf("KEEL_APPROVALS" to base)))
        assertEquals(2 to who, capture(listOf("inbox"), mapOf("KEEL_USER" to " ", "KEEL_APPROVALS" to base)))
        assertEquals(2 to "signoff inbox | watch | approve <id> [note] | decline <id> <note>", capture(listOf("sign"), env))
    }

    @Test
    fun `the program's watch prints each request once, as it is asked`() = runBlocking {
        val first = ask("u4", "First.pdf")
        val out = Lines()
        val watching = launch { run(listOf("watch"), mapOf("KEEL_USER" to "tomas", "KEEL_APPROVALS" to base), PrintStream(out, true, Charsets.UTF_8)) }
        try {
            assertEquals("Watching what is asked of you. Ctrl+C to stop.", out.next())
            assertEquals("waiting: $first  First.pdf (v3), asked by Ada Lovelace", out.next())
            // the inbox now holds both: only the new one is printed
            val second = ask("u4", "Second.pdf")
            assertEquals("waiting: $second  Second.pdf (v3), asked by Ada Lovelace", out.next())
            // one leaving prints nothing, and one asked after it is printed once
            Desk(base, "tomas").use { assertIs<Decided.Done>(it.decide(first, Decision.approved, null)) }
            val third = ask("u4", "Third.pdf")
            assertEquals("waiting: $third  Third.pdf (v3), asked by Ada Lovelace", out.next())
        } finally {
            watching.cancelAndJoin()
        }
        assertEquals(null, out.lines.tryReceive().getOrNull())
    }
}
