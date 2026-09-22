/**
 * Who can sign in, as every service in the fleet knows them: the same four people, the same ids, the same cookie.
 * This is this service's copy of `packages/service-kit/src/team.ts`, because a fleet has one roster and each
 * service keeps its own; the identity provider that stands behind both is the same one.
 */
package keel.approvals

data class Person(val id: String, val handle: String, val name: String)

object Roster {
    const val SESSION_COOKIE = "keel_session"

    val team: List<Person> = listOf(
        Person("u1", "ada", "Ada Lovelace"),
        Person("u2", "grace", "Grace Hopper"),
        Person("u3", "noor", "Noor Haddad"),
        Person("u4", "tomas", "Tomás Ferreira"),
    )

    fun byId(id: String): Person? = team.firstOrNull { it.id == id }

    /** A bearer handle names a program; the cookie is what a browser sends. An unknown handle is nobody, not an error. */
    fun of(authorization: String?, cookie: String?): Person? {
        val bearer = authorization?.takeIf { it.startsWith("Bearer ") }?.removePrefix("Bearer ")
        val handle = bearer ?: cookieValue(cookie, SESSION_COOKIE)
        return handle?.let { h -> team.firstOrNull { it.handle == h } }
    }

    private fun cookieValue(header: String?, name: String): String? = header
        ?.split(";")
        ?.map { it.trim() }
        ?.firstOrNull { it.startsWith("$name=") }
        ?.removePrefix("$name=")
        ?.let { java.net.URLDecoder.decode(it, Charsets.UTF_8) }
}
