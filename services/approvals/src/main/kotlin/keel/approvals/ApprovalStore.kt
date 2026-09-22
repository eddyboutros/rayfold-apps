/**
 * The approvals table, and nothing shared: what this service knows of a document is what a request carried.
 */
package keel.approvals

import java.sql.Connection
import java.sql.ResultSet

data class Approval(
    val id: String,
    val documentId: String,
    val projectId: String,
    val documentName: String,
    val version: Int,
    val requesterId: String,
    val approverId: String,
    val decision: String,
    val note: String?,
    val stale: Boolean,
    val askedAt: Long,
    val decidedAt: Long?,
)

class ApprovalStore(private val connections: () -> Connection) {
    /** Safe to run from every instance at once, like the platform's own tables. */
    fun migrate() {
        connections().use { c ->
            c.createStatement().use {
                it.execute(
                    """
                    create table if not exists approvals (
                      id text primary key,
                      document_id text not null,
                      project_id text not null,
                      document_name text not null,
                      version int not null,
                      requester_id text not null,
                      approver_id text not null,
                      decision text not null,
                      note text,
                      stale boolean not null default false,
                      asked_at bigint not null,
                      decided_at bigint
                    )
                    """.trimIndent(),
                )
                it.execute("create index if not exists approvals_document on approvals (document_id, asked_at desc)")
                it.execute("create index if not exists approvals_approver on approvals (approver_id, decision, asked_at)")
            }
        }
    }

    fun find(id: String): Approval? = connections().use { c ->
        c.prepareStatement("select * from approvals where id = ?").use { s ->
            s.setString(1, id)
            s.executeQuery().use { if (it.next()) it.approval() else null }
        }
    }

    fun ofDocument(documentId: String): List<Approval> = connections().use { c ->
        c.prepareStatement("select * from approvals where document_id = ? order by asked_at desc, id").use { s ->
            s.setString(1, documentId)
            s.executeQuery().use { rs -> generateSequence { if (rs.next()) rs.approval() else null }.toList() }
        }
    }

    fun inbox(approverId: String): List<Approval> = connections().use { c ->
        c.prepareStatement("select * from approvals where approver_id = ? and decision = 'pending' order by asked_at, id").use { s ->
            s.setString(1, approverId)
            s.executeQuery().use { rs -> generateSequence { if (rs.next()) rs.approval() else null }.toList() }
        }
    }

    fun insert(a: Approval) {
        connections().use { c ->
            c.prepareStatement("insert into approvals (id, document_id, project_id, document_name, version, requester_id, approver_id, decision, note, stale, asked_at, decided_at) values (?,?,?,?,?,?,?,?,?,?,?,?)").use { s ->
                s.setString(1, a.id); s.setString(2, a.documentId); s.setString(3, a.projectId); s.setString(4, a.documentName)
                s.setInt(5, a.version); s.setString(6, a.requesterId); s.setString(7, a.approverId); s.setString(8, a.decision)
                s.setString(9, a.note); s.setBoolean(10, a.stale); s.setLong(11, a.askedAt); s.setObject(12, a.decidedAt)
                s.executeUpdate()
            }
        }
    }

    /** Lands only while the sign-off is still pending: two decisions cannot both win, and the second is told. */
    fun decide(id: String, decision: String, note: String?, at: Long): Boolean = connections().use { c ->
        c.prepareStatement("update approvals set decision = ?, note = ?, decided_at = ? where id = ? and decision = 'pending'").use { s ->
            s.setString(1, decision); s.setString(2, note); s.setLong(3, at); s.setString(4, id)
            s.executeUpdate() == 1
        }
    }

    /** Every pending sign-off on an older version of the document, marked; answers how many were. */
    fun markStale(documentId: String, version: Int): List<Approval> = connections().use { c ->
        c.prepareStatement("update approvals set stale = true where document_id = ? and version < ? and decision = 'pending' and stale = false returning *").use { s ->
            s.setString(1, documentId); s.setInt(2, version)
            s.executeQuery().use { rs -> generateSequence { if (rs.next()) rs.approval() else null }.toList() }
        }
    }

    private fun ResultSet.approval() = Approval(
        id = getString("id"),
        documentId = getString("document_id"),
        projectId = getString("project_id"),
        documentName = getString("document_name"),
        version = getInt("version"),
        requesterId = getString("requester_id"),
        approverId = getString("approver_id"),
        decision = getString("decision"),
        note = getString("note"),
        stale = getBoolean("stale"),
        askedAt = getLong("asked_at"),
        decidedAt = getObject("decided_at")?.let { (it as Number).toLong() },
    )
}
