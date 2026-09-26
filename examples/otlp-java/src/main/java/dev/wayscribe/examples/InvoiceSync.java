package dev.wayscribe.examples;

import io.opentelemetry.api.common.KeyValue;
import io.opentelemetry.api.common.Value;
import io.opentelemetry.api.logs.LogRecordBuilder;
import io.opentelemetry.api.logs.Logger;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.exporter.otlp.http.logs.OtlpHttpLogRecordExporter;
import io.opentelemetry.exporter.otlp.http.logs.OtlpHttpLogRecordExporterBuilder;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.logs.SdkLoggerProvider;
import io.opentelemetry.sdk.logs.export.BatchLogRecordProcessor;
import io.opentelemetry.sdk.resources.Resource;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.TimeUnit;

/**
 * A billing worker that moves one invoice into the ledger and states each business step as an
 * annotated OpenTelemetry log record. Body and severity are ignored by Wayscribe; the
 * wayscribe.* attributes are the journey evidence. It also writes one ordinary operational log
 * line, which the Collector example filters out before it reaches Wayscribe.
 */
public final class InvoiceSync {
  private static final String JOURNEY = "jrn_otlp_java_inv_2044";

  // Stable synthetic IDs and timestamps so a second run proves idempotency. A real service
  // persists the ID and timestamp with its work and resends both unchanged on a retry.
  private static final Instant START = Instant.parse("2026-09-26T09:00:00Z");

  public static void main(String[] args) {
    String endpoint = env("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "http://127.0.0.1:4318/v1/logs");
    OtlpHttpLogRecordExporterBuilder exporter =
        OtlpHttpLogRecordExporter.builder()
            .setEndpoint(endpoint)
            .setCompression("gzip")
            .setTimeout(Duration.ofSeconds(10));
    // Only when sending straight to Wayscribe. Behind the Collector, the Collector holds the key.
    String apiKey = System.getenv("WAYSCRIBE_API_KEY");
    if (apiKey != null && !apiKey.isEmpty()) {
      exporter.addHeader("Authorization", "Bearer " + apiKey);
    }

    SdkLoggerProvider provider =
        SdkLoggerProvider.builder()
            .setResource(
                Resource.getDefault().toBuilder()
                    .put("service.name", "invoice-sync")
                    .put("service.version", "3.4.0")
                    .build())
            // Wayscribe accepts at most 100 records per export.
            .addLogRecordProcessor(
                BatchLogRecordProcessor.builder(exporter.build())
                    .setMaxExportBatchSize(100)
                    .setScheduleDelay(Duration.ofMillis(200))
                    .build())
            .build();

    try {
      run(provider.get("invoice-sync"));
      CompletableResultCode flushed = provider.forceFlush().join(15, TimeUnit.SECONDS);
      if (!flushed.isSuccess()) {
        throw new IllegalStateException("exporter did not flush 6 records to " + endpoint);
      }
      System.out.println("invoice-sync flushed 6 records (5 journey, 1 operational) to " + endpoint);
    } finally {
      provider.shutdown().join(15, TimeUnit.SECONDS);
    }
  }

  private static void run(Logger logger) {
    Value<?> invoice =
        Value.of(
            KeyValue.of("invoiceId", Value.of("inv-2044")),
            KeyValue.of("customerEmail", Value.of("ada@example.test")),
            KeyValue.of("amountCents", Value.of(48000L)),
            KeyValue.of("currency", Value.of("USD")),
            // A card number and an API token that must not leave this host; the Collector
            // example masks the first and deletes the second.
            KeyValue.of("cardNumber", Value.of("4111 1111 1111 1111")),
            KeyValue.of("gatewayApiToken", Value.of("synthetic-gateway-token")));

    journey(logger, "evt_otlp_java_received", 0, "received", "load-invoice")
        .setAttribute("wayscribe.aliases", Value.of(KeyValue.of("billing", Value.of("BIL-88213"))))
        .setAttribute("wayscribe.output", invoice)
        .emit();

    journey(logger, "evt_otlp_java_transformed", 40, "transformed", "map-to-ledger-entry")
        .setAttribute("wayscribe.parent_event.id", "evt_otlp_java_received")
        .setAttribute("wayscribe.duration_ms", 7L)
        .setAttribute("wayscribe.input", invoice)
        .setAttribute(
            "wayscribe.output",
            Value.of(
                KeyValue.of("invoiceId", Value.of("inv-2044")),
                KeyValue.of("amountCents", Value.of(48000L)),
                KeyValue.of("currency", Value.of("usd")),
                KeyValue.of("account", Value.of("4000-receivables"))))
        .emit();

    // The first delivery attempt fails; a failed attempt is `delivered` with an error.
    journey(logger, "evt_otlp_java_delivery_1", 300, "delivered", "post-ledger-entry")
        .setAttribute("wayscribe.parent_event.id", "evt_otlp_java_transformed")
        .setAttribute("wayscribe.attempt", 1L)
        .setAttribute("wayscribe.metadata", Value.of(KeyValue.of("httpStatus", Value.of(503L))))
        .setAttribute(
            "wayscribe.error",
            Value.of(
                KeyValue.of("type", Value.of("LedgerUnavailable")),
                KeyValue.of("message", Value.of("ledger returned 503")),
                KeyValue.of("code", Value.of("LEDGER_503"))))
        .emit();

    // The second attempt works: `retried` with no error clears the failure.
    journey(logger, "evt_otlp_java_delivery_2", 1200, "retried", "post-ledger-entry")
        .setAttribute("wayscribe.parent_event.id", "evt_otlp_java_delivery_1")
        .setAttribute("wayscribe.attempt", 2L)
        .setAttribute(
            "wayscribe.metadata",
            Value.of(
                KeyValue.of("httpStatus", Value.of(201L)),
                KeyValue.of("ledgerEntryId", Value.of("le-551907"))))
        .emit();

    journey(logger, "evt_otlp_java_completed", 1250, "completed", "invoice-synced")
        .setAttribute("wayscribe.parent_event.id", "evt_otlp_java_delivery_2")
        .emit();

    // Ordinary operational logging from the same service. It names no journey, so the Collector
    // example drops it; sent straight to Wayscribe it is refused with missing_attribute.
    logger
        .logRecordBuilder()
        .setTimestamp(START.plusMillis(1300))
        .setSeverity(Severity.INFO)
        .setBody("ledger connection pool: 4 idle, 0 busy")
        .emit();
  }

  private static LogRecordBuilder journey(
      Logger logger, String eventId, long offsetMillis, String operation, String name) {
    return logger
        .logRecordBuilder()
        .setTimestamp(START.plusMillis(offsetMillis))
        .setSeverity(operation.equals("delivered") ? Severity.WARN : Severity.INFO)
        .setBody(operation + " " + name)
        // What a logging library typically adds. Wayscribe ignores it; the Collector example
        // removes it before it leaves the host.
        .setAttribute("thread.name", Thread.currentThread().getName())
        .setAttribute("wayscribe.event.id", eventId)
        .setAttribute("wayscribe.journey.id", JOURNEY)
        .setAttribute("wayscribe.journey.label", "Invoice inv-2044 into the ledger")
        .setAttribute("wayscribe.entity.type", "invoice")
        .setAttribute("wayscribe.entity.id", "inv-2044")
        .setAttribute("wayscribe.operation", operation)
        .setAttribute("wayscribe.name", name);
  }

  private static String env(String name, String fallback) {
    String value = System.getenv(name);
    return value == null || value.isEmpty() ? fallback : value;
  }
}
