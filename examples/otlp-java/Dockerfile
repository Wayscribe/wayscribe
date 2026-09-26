# Build with Maven, run on a JRE. Build context is this directory.
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -q -B dependency:go-offline
COPY src ./src
RUN mvn -q -B package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/target/invoice-sync-1.0.0.jar /src/target/lib/ ./
USER 10001
ENTRYPOINT ["java", "-cp", "/app/*", "dev.wayscribe.examples.InvoiceSync"]
