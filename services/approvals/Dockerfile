# The fleet's JVM member, built the way it is tested: the Maven wrapper, then one jar on a JRE. The build stage keeps
# the dependency download in its own layer, so a change to source does not fetch the world again.
FROM eclipse-temurin:21-jdk AS build
WORKDIR /build
COPY services/approvals/pom.xml services/approvals/mvnw ./
COPY services/approvals/.mvn .mvn
RUN ./mvnw -q -B dependency:go-offline
COPY services/approvals/src src
RUN ./mvnw -q -B -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /build/target/approvals-0.1.0.jar app.jar
ENV PORT=4004
EXPOSE 4004
# PID 1 receives SIGTERM directly; Spring's context close drains the Rayfold server before the port closes
ENTRYPOINT ["java", "-jar", "app.jar"]
