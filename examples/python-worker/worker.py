#!/usr/bin/env python3
"""Small existing-worker example instrumented with the Wayscribe SDK."""

from __future__ import annotations

import json
import os

from wayscribe import create_recorder


class DeliveryRejected(Exception):
    pass


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main() -> None:
    entity_id = os.environ.get("WORKER_ENTITY_ID", "customer-python-42")
    alias = os.environ.get("WORKER_ALIAS", "crm-python-9001")
    recorder = create_recorder(
        endpoint=required("WAYSCRIBE_ENDPOINT"),
        api_key=required("WAYSCRIBE_API_KEY"),
        service="python-worker",
        environment=os.environ.get("WAYSCRIBE_ENVIRONMENT", "development"),
    )
    journey = recorder.journey({"type": "customer", "id": entity_id})
    journey.identify({"crmCustomerId": alias})

    source = {
        "customerId": entity_id,
        "phone": "+1 919 555 1234",
        "password": "worker-secret",
    }
    normalized = journey.transform(
        "normalize-customer",
        source,
        lambda: {**source, "phone": None},
    )

    rejection = DeliveryRejected("target refused the customer")

    def reject() -> None:
        raise rejection

    try:
        journey.deliver("deliver-customer", normalized, reject)
    except DeliveryRejected as caught:
        if caught is not rejection:
            raise RuntimeError("the wrapper replaced the host exception") from caught

    result = journey.deliver(
        "deliver-customer",
        normalized,
        lambda: {"accepted": False},
        attempt=2,
        is_failure=lambda response: (
            None
            if response["accepted"]
            else {"message": "target rejected retry", "code": "target_rejected"}
        ),
    )
    if result != {"accepted": False}:
        raise RuntimeError("the wrapper replaced the host result")

    journey.complete()
    recorder.shutdown(timeout_ms=5000)
    print(
        json.dumps(
            {
                "journeyId": journey.context()["journeyId"],
                "entityId": entity_id,
                "alias": alias,
                "counters": recorder.counters(),
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
