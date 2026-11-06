#!/usr/bin/env python3
"""Read a privacy-safe, ordered 8 Lakes booking funnel from GA4 Data API.

Requires a service account with analytics.readonly on the exact GA4 property.
It never sends Measurement Protocol events or changes GA4 configuration.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2 import service_account

PROPERTY_ID = "535539074"
SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"]
# Stages are intentionally business events, not clicks mistaken for outcomes.
FUNNEL_STEPS = [
    ("Tour viewed", "view_tour"),
    ("Booking CTA clicked", "booking_cta_click"),
    ("Booking form started", "booking_form_start"),
    ("Booking form submitted", "booking_form_submit"),
    ("Checkout session created", "begin_checkout"),
    ("Checkout redirect started", "checkout_redirect_started"),
    ("Paid (server-confirmed)", "payment_received"),
]


def request_json(session: AuthorizedSession, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
    response = session.post(endpoint, json=payload, timeout=45)
    if response.status_code != 200:
        # API errors may contain diagnostic text, but never echo credentials or request headers.
        try:
            detail = response.json().get("error", {}).get("message", "")
        except ValueError:
            detail = ""
        raise RuntimeError(f"GA4 Data API HTTP {response.status_code}: {detail[:240]}")
    return response.json()


def funnel_payload(start_date: str, end_date: str, source_breakdown: bool) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "dateRanges": [{"startDate": start_date, "endDate": end_date}],
        "funnel": {
            "isOpenFunnel": True,
            "steps": [
                {
                    "name": label,
                    "filterExpression": {
                        "funnelFieldFilter": {
                            "fieldName": "eventName",
                            "stringFilter": {"matchType": "EXACT", "value": event_name},
                        }
                    },
                }
                for label, event_name in FUNNEL_STEPS
            ],
        },
        "funnelVisualizationType": "STANDARD_FUNNEL",
        "returnPropertyQuota": False,
    }
    if source_breakdown:
        payload["funnelBreakdown"] = {"breakdownDimension": {"name": "sessionSourceMedium"}}
    return payload


def compact_rows(response: dict[str, Any]) -> list[dict[str, Any]]:
    """Keep only aggregate funnel response fields; GA4 does not return user rows."""
    table = response.get("funnelTable", {})
    tables = [table] if isinstance(table, dict) else table
    result: list[dict[str, Any]] = []
    for table in tables:
        headers = [header.get("name", "unknown") for header in table.get("dimensionHeaders", [])]
        metric_headers = [header.get("name", "unknown") for header in table.get("metricHeaders", [])]
        for row in table.get("rows", []):
            dimensions = {
                headers[index]: value.get("value", "")
                for index, value in enumerate(row.get("dimensionValues", []))
                if index < len(headers)
            }
            metrics = {
                metric_headers[index]: value.get("value", "0")
                for index, value in enumerate(row.get("metricValues", []))
                if index < len(metric_headers)
            }
            result.append({"dimensions": dimensions, "metrics": metrics})
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", type=Path, required=True, help="Service-account JSON path (never logged)")
    parser.add_argument("--property", default=PROPERTY_ID, help="GA4 property ID; defaults to the exact 8 Lakes property")
    parser.add_argument("--start-date", default="90daysAgo")
    parser.add_argument("--end-date", default="today")
    parser.add_argument("--output", type=Path, required=True, help="Sanitized JSON output path")
    args = parser.parse_args()
    if args.property != PROPERTY_ID:
        parser.error(f"This report is scoped to GA4 property {PROPERTY_ID}; refusing {args.property}.")
    if not args.credentials.is_file():
        parser.error("credential file was not found")

    credentials = service_account.Credentials.from_service_account_file(str(args.credentials), scopes=SCOPES)
    credentials.refresh(Request())
    session = AuthorizedSession(credentials)
    # runFunnelReport is currently exposed by the GA Data API v1alpha surface.
    endpoint = f"https://analyticsdata.googleapis.com/v1alpha/properties/{args.property}:runFunnelReport"
    overall = request_json(session, endpoint, funnel_payload(args.start_date, args.end_date, False))
    by_source = request_json(session, endpoint, funnel_payload(args.start_date, args.end_date, True))
    report = {
        "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "property_id": args.property,
        "date_range": {"start_date": args.start_date, "end_date": args.end_date},
        "stages": [{"label": label, "event_name": event_name} for label, event_name in FUNNEL_STEPS],
        "overall": compact_rows(overall),
        "by_session_source_medium": compact_rows(by_source),
        "limits": [
            "GA4 funnel data is aggregate and processed; it does not identify people or create a recovery audience.",
            "The funnel is open: users may enter at any step. Counts are ordered within each included user journey, not subtraction between independent event totals.",
            "payment_received is the only paid-completion stage and is emitted server-side only after a real Stripe-confirmed payment with consented GA attribution.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote sanitized GA4 funnel report: {args.output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"GA4 funnel report failed: {error}", file=sys.stderr)
        raise SystemExit(1)
