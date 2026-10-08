/**
 * signoff: work through the sign-offs asked of you, from a terminal.
 *
 *   signoff inbox                    what is waiting on you, oldest first
 *   signoff watch                    the same, kept open: a new request is printed as it is asked (Ctrl+C to stop)
 *   signoff approve <id> [note]      approve one
 *   signoff decline <id> <note>      decline one, saying why
 *
 * KEEL_USER says who you are (a handle on the team: ada, grace, noor, tomas); KEEL_APPROVALS where the approvals
 * service is, http://localhost:4004 by default, which is where `npm run dev` puts it.
 */
package keel.signoff

import keel.signoff.api.Approval
import keel.signoff.api.Decision
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.runBlocking
import java.io.PrintStream
import kotlin.system.exitProcess

/** One line per sign-off: enough to recognise the document and to type its id. */
fun line(a: Approval): String =
    "${a.id}  ${a.documentName} (v${a.version}), asked by ${a.requester.name}${if (a.stale) " - a newer version has been kept since" else ""}"

/**
 * The program, given its arguments, its environment and somewhere to write. Answers the exit code: 0 done, 1 refused,
 * 2 not understood. `main` is this with the process's own.
 */
suspend fun run(args: List<String>, env: Map<String, String>, out: PrintStream): Int {
    val user = env["KEEL_USER"]
    if (user.isNullOrBlank()) {
        out.println("Who are you? Set KEEL_USER to your handle on the team, e.g. KEEL_USER=tomas.")
        return 2
    }
    val base = env["KEEL_APPROVALS"] ?: "http://localhost:4004"
    Desk(base, user).use { desk ->
        return when (args.firstOrNull()) {
            "inbox" -> {
                val waiting = desk.inbox()
                if (waiting.isEmpty()) out.println("Nothing is waiting on you.")
                else waiting.forEach { out.println(line(it)) }
                0
            }
            "watch" -> {
                out.println("Watching what is asked of you. Ctrl+C to stop.")
                var seen = emptySet<String>()
                desk.watch().collect { waiting ->
                    waiting.filter { it.id !in seen }.forEach { out.println("waiting: ${line(it)}") }
                    seen = waiting.map { it.id }.toSet()
                }
                0
            }
            "approve", "decline" -> {
                val id = args.getOrNull(1)
                val note = args.drop(2).joinToString(" ").ifBlank { null }
                if (id == null || (args[0] == "decline" && note == null)) {
                    out.println(if (id == null) "Which one? signoff ${args[0]} <id>" else "Say why: signoff decline <id> <note>")
                    return 2
                }
                when (val decided = desk.decide(id, if (args[0] == "approve") Decision.approved else Decision.declined, note)) {
                    is Decided.Done -> { out.println("${decided.approval.decision}: ${decided.approval.documentName} (v${decided.approval.version})"); 0 }
                    is Decided.AlreadyDecided -> { out.println("Already ${decided.decision}: nothing changed."); 1 }
                    Decided.NotYours -> { out.println("That one was not asked of you."); 1 }
                    Decided.NotFound -> { out.println("There is no sign-off $id."); 1 }
                }
            }
            else -> {
                out.println("signoff inbox | watch | approve <id> [note] | decline <id> <note>")
                2
            }
        }
    }
}

fun main(args: Array<String>) {
    exitProcess(runBlocking { run(args.toList(), System.getenv(), System.out) })
}
