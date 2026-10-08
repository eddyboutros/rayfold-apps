/**
 * The sign-off queue as a program sees it: what is waiting on me, what lands while I watch, and a decision on one.
 *
 * Two connections to one service, as a screen would hold them: plain HTTP for a read and for a command, which come
 * and go, and one socket for the inbox kept live, which stays. What crosses them is typed by the classes `rayfold gen
 * kotlin` wrote from the approvals service's schema, so a field the schema renames is a compile error here rather
 * than a blank column in someone's terminal.
 */
package keel.signoff

import dev.rayfold.client.HttpTransport
import dev.rayfold.client.JdkWebSocketTransport
import dev.rayfold.client.RayfoldClient
import dev.rayfold.client.RayfoldClientException
import dev.rayfold.client.liveAs
import dev.rayfold.client.queryAs
import keel.signoff.api.AlreadyDecided
import keel.signoff.api.Approval
import keel.signoff.api.Decision
import keel.signoff.api.Ops
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import java.net.URI

/**
 * How the generated classes are read and written. A member the service adds later is ignored rather than refused: a
 * compatible change to its schema must not break a program built against the one before.
 */
internal val json = Json { ignoreUnknownKeys = true }

/** Every field the generated [Approval] holds: a typed result is decoded whole, so the shape asks for all of it. */
const val APPROVAL = "{ id documentId projectId documentName version requester { id name } approver { id name } decision note stale askedAt decidedAt }"

/** What became of a decision. A refusal the schema declares is an answer, not a crash. */
sealed interface Decided {
    data class Done(val approval: Approval) : Decided
    /** Someone got there first: the request was withdrawn, or this was already decided. */
    data class AlreadyDecided(val decision: Decision) : Decided
    /** It was not asked of the person deciding. */
    data object NotYours : Decided
    data object NotFound : Decided
}

/**
 * One person's desk. `user` is who they are signed in as: a program has no browser and no session cookie, so it sends
 * the handle as a bearer, as every program in this fleet does.
 */
class Desk(base: String, user: String) : AutoCloseable {
    private val headers = mapOf("Authorization" to "Bearer $user")
    private val http = RayfoldClient(HttpTransport("${base.trimEnd('/')}/rayfold", { headers }))
    private val socket = JdkWebSocketTransport(URI(base.trimEnd('/').replaceFirst("http", "ws") + "/rayfold/ws"), headers)
    private val live = RayfoldClient(socket)

    /** What is waiting on me, oldest first. */
    suspend fun inbox(): List<Approval> = http.queryAs(Ops.INBOX, JsonObject(emptyMap()), APPROVAL)

    /**
     * The inbox, again every time it changes, whoever changed it: a sign-off asked of me in a browser on the other side
     * of the office lands here as it is asked. Collect it in a scope; cancelling the collection ends the subscription.
     */
    fun watch(): Flow<List<Approval>> = live.liveAs(Ops.INBOX, JsonObject(emptyMap()), APPROVAL)

    /**
     * Approve or decline. `key` is the command's idempotency key: a caller that does not know whether its first try
     * landed sends the same key again, and the service answers with the first try's result instead of deciding twice.
     */
    suspend fun decide(id: String, decision: Decision, note: String?, key: String = http.newKey()): Decided {
        val args = json.encodeToJsonElement(Ops.DecideArgs(id, decision, note)).jsonObject
        return try {
            Decided.Done(json.decodeFromJsonElement<Approval>(http.command(Ops.DECIDE, args, APPROVAL, key)))
        } catch (e: RayfoldClientException) {
            when {
                e.isType("AlreadyDecided") -> Decided.AlreadyDecided(json.decodeFromJsonElement<AlreadyDecided>(e.data ?: buildJsonObject {}).decision)
                e.isType("NotYours") -> Decided.NotYours
                e.isType("NotFound") -> Decided.NotFound
                else -> throw e
            }
        }
    }

    override fun close() {
        socket.close()
    }
}
