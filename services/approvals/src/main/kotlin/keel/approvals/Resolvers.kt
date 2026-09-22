/**
 * What the approvals service does, as Rayfold resolvers over kotlinx JSON.
 *
 * A command answers with the changed entity and the event the schema says it emits; the runtime turns the entity
 * into the patch every live query hears and puts the event on the relay for the other services. The one thing worth
 * reading twice is [hearTheFleet]: an event raised in another runtime, on another port, changes rows here.
 */
package keel.approvals

import dev.rayfold.core.CommandResult
import dev.rayfold.core.RayfoldContext
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Resolvers
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.apache.commons.logging.Log
import java.util.UUID

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content
private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content?.toIntOrNull()
private val RayfoldContext.viewerId: String get() = viewer.jsonObject.str("id") ?: throw RayfoldException(dev.rayfold.core.Code.PERMISSION_DENIED, "Not signed in")
private val RayfoldContext.viewerName: String get() = viewer.jsonObject.str("name") ?: "Someone"

/** An approval as the schema's entity: the two people as ids, loaded as Members by the field loaders below. */
private fun Approval.json(): JsonObject = buildJsonObject {
    put("\$type", "Approval")
    put("id", id); put("documentId", documentId); put("projectId", projectId); put("documentName", documentName)
    put("version", version); put("requesterId", requesterId); put("approverId", approverId)
    put("decision", decision); put("note", note); put("stale", stale); put("askedAt", askedAt); put("decidedAt", decidedAt)
}

private fun member(id: String): JsonElement = Roster.byId(id)?.let { buildJsonObject { put("\$type", "Member"); put("id", it.id); put("name", it.name) } } ?: JsonNull

private fun notFound(id: String) = RayfoldException.domain("NotFound", buildJsonObject { put("id", id) }, "No approval $id")
private fun notYours(id: String, why: String) = RayfoldException.domain("NotYours", buildJsonObject { put("id", id) }, why)

fun approvalResolvers(store: ApprovalStore, now: () -> Long = System::currentTimeMillis, id: () -> String = { UUID.randomUUID().toString() }): Resolvers = Resolvers(
    queries = mapOf(
        "approval" to { args, _ -> store.find(args.str("id") ?: "")?.json() },
        "approvals" to { args, _ -> buildJsonArray { store.ofDocument(args.str("documentId") ?: "").forEach { add(it.json()) } } },
        "inbox" to { _, ctx -> buildJsonArray { store.inbox(ctx.viewerId).forEach { add(it.json()) } } },
        "members" to { _, _ -> buildJsonArray { Roster.team.forEach { add(member(it.id)) } } },
    ),
    commands = mapOf(
        "requestApproval" to { args, ctx ->
            val approverId = args.str("approverId") ?: ""
            if (approverId == ctx.viewerId) throw notYours("", "A sign-off is asked of someone else")
            if (Roster.byId(approverId) == null) throw RayfoldException.domain("NotFound", buildJsonObject { put("id", approverId) }, "No member $approverId")
            val a = Approval(
                id = id(),
                documentId = args.str("documentId") ?: "",
                projectId = args.str("projectId") ?: "",
                documentName = args.str("documentName") ?: "",
                version = args.int("version") ?: 1,
                requesterId = ctx.viewerId,
                approverId = approverId,
                decision = "pending",
                note = null,
                stale = false,
                askedAt = now(),
                decidedAt = null,
            )
            store.insert(a)
            CommandResult(
                a.json(),
                // a new row: every open list of this document's sign-offs and the approver's inbox re-run
                patch = listOf(buildJsonObject { put("invOp", buildJsonArray { add(JsonPrimitive("approvals")); add(JsonPrimitive("inbox")) }) }),
                emit = listOf("ApprovalRequested" to buildJsonObject {
                    put("approvalId", a.id); put("documentId", a.documentId); put("projectId", a.projectId); put("documentName", a.documentName)
                    put("requesterId", a.requesterId); put("approverId", a.approverId)
                }),
            )
        },
        "decide" to { args, ctx ->
            val a = store.find(args.str("id") ?: "") ?: throw notFound(args.str("id") ?: "")
            if (a.approverId != ctx.viewerId) throw notYours(a.id, "${a.documentName} was not asked of you")
            val decision = args.str("decision") ?: "approved"
            if (decision != "approved" && decision != "declined") throw RayfoldException(dev.rayfold.core.Code.INVALID_ARGUMENT, "decide(): decision must be approved or declined")
            decided(store, a, decision, args.str("note"), ctx, now())
        },
        "withdraw" to { args, ctx ->
            val a = store.find(args.str("id") ?: "") ?: throw notFound(args.str("id") ?: "")
            if (a.requesterId != ctx.viewerId) throw notYours(a.id, "${a.documentName} was not asked by you")
            decided(store, a, "withdrawn", null, ctx, now())
        },
    ),
    fields = mapOf(
        "Approval" to mapOf(
            "requester" to { parents, _, _ -> parents.map { member(it.str("requesterId") ?: "") } },
            "approver" to { parents, _, _ -> parents.map { member(it.str("approverId") ?: "") } },
        ),
    ),
)

/** The one write both decisions share: lands only while pending, and the second decision is told what the first was. */
private fun decided(store: ApprovalStore, a: Approval, decision: String, note: String?, ctx: RayfoldContext, at: Long): CommandResult {
    if (a.decision != "pending") throw RayfoldException.domain("AlreadyDecided", buildJsonObject { put("id", a.id); put("decision", a.decision) }, "${a.documentName} is already ${a.decision}")
    if (!store.decide(a.id, decision, note, at)) {
        val current = store.find(a.id) ?: throw notFound(a.id)
        throw RayfoldException.domain("AlreadyDecided", buildJsonObject { put("id", a.id); put("decision", current.decision) }, "${a.documentName} is already ${current.decision}")
    }
    val next = a.copy(decision = decision, note = note, decidedAt = at)
    return CommandResult(
        next.json(),
        patch = listOf(buildJsonObject { put("invOp", buildJsonArray { add(JsonPrimitive("inbox")) }) }),
        emit = listOf("ApprovalDecided" to buildJsonObject {
            put("approvalId", next.id); put("documentId", next.documentId); put("projectId", next.projectId); put("documentName", next.documentName)
            put("decision", decision); put("byId", ctx.viewerId); put("note", note)
        }),
    )
}

/**
 * What this service hears from the others. `DocumentChanged` is raised by the documents service, in TypeScript, on
 * another port; the relay delivers it to every instance of this one. Each instance marks the rows (the update is
 * idempotent, so several instances racing leave one truth) and wakes its own connected clients.
 */
fun hearTheFleet(server: RayfoldServer, store: ApprovalStore, log: Log) {
    server.events.on("DocumentChanged") { payload ->
        val documentId = payload.str("documentId") ?: return@on
        val version = payload.int("version") ?: return@on
        try {
            val stale = store.markStale(documentId, version)
            if (stale.isNotEmpty()) {
                log.info("[approvals] ${stale.size} sign-off(s) on $documentId are stale: version $version was kept")
                // delivered, not published: the change is local rows, and every instance heard the same event
                server.changes.deliver(dev.rayfold.core.Change(stale.map { "Approval:${it.id}" }.toSet(), setOf("approvals", "inbox")))
            }
        } catch (e: Exception) {
            log.error("[approvals] could not mark sign-offs stale for $documentId", e)
        }
    }
}
