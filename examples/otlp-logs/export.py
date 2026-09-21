"""Explicit business annotations; body and severity do not create journey fields."""
import os
from importlib.metadata import version
from opentelemetry._logs import LogRecord, SeverityNumber
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.exporter.otlp.proto.http import Compression
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter

provider = LoggerProvider(resource=Resource.create({
    "service.name": "otlp-example", "deployment.environment.name": "development",
    "service.version": "1.0.0",
}))
exporter = OTLPLogExporter(
    endpoint=os.environ["OTLP_EXAMPLE_ENDPOINT"],
    headers={"Authorization": "Bearer " + os.environ["OTLP_EXAMPLE_API_KEY"]},
    timeout=5, compression=Compression.Gzip,
)
provider.add_log_record_processor(BatchLogRecordProcessor(
    exporter, max_export_batch_size=100, max_queue_size=100,
    schedule_delay_millis=100, export_timeout_millis=10000,
))
try:
    logger = provider.get_logger("wayscribe-annotated-example")
    common = {
        "wayscribe.journey.id": "jrn_otlp_official",
        "wayscribe.entity.type": "customer", "wayscribe.entity.id": "customer-otlp-42",
        "wayscribe.aliases": {"crm": "crm-otlp-9001"},
    }
    # In a real application persist these event IDs and timestamps with the work.
    # Re-emitting an existing event must retain both and all its annotations.
    logger.emit(LogRecord(timestamp=1786032000120000000,
        trace_id=int("0123456789abcdef0123456789abcdef", 16),
        span_id=int("0123456789abcdef", 16),
        severity_number=SeverityNumber.ERROR, body="ignored generic text",
        attributes={**common, "wayscribe.event.id": "evt_otlp_official_transform",
            "wayscribe.operation": "transformed", "wayscribe.name": "normalize-customer",
            "wayscribe.input": {"phone": "555-0100", "password": "synthetic-secret"},
            "wayscribe.output": {"phone": None, "password": "synthetic-secret"}}))
    logger.emit(LogRecord(timestamp=1786032001120000000,
        attributes={**common, "wayscribe.event.id": "evt_otlp_official_failure",
            "wayscribe.operation": "failed", "wayscribe.name": "deliver-customer",
            "wayscribe.error": {"type": "DeliveryRejected", "message": "Target rejected delivery"}}))
    if not provider.force_flush(timeout_millis=15000):
        raise RuntimeError("Exporter did not flush before deadline")
    print("official exporter=" + version("opentelemetry-exporter-otlp-proto-http") +
          " sdk=" + version("opentelemetry-sdk") + " flushed 2 annotated records")
finally:
    provider.shutdown()
