"""Block export, share, and completion until the quality gate approves."""

from __future__ import annotations

from typing import Any

BLOCKED_EVENTS = (
    "pptx_export",
    "pdf_export",
    "external_sharing",
    "final_drive_folder_promotion",
    "email_send",
    "workflow_final",
    "workflow_exported",
    "workflow_delivered",
    "workflow_shared",
    "workflow_completed",
)

ALLOW_STATUSES = {"approved", "approved_with_minor_revisions"}


def can_finalize(
    status: str,
    *,
    emergency_bypass_enabled: bool = False,
    bypass_reason: str = "",
    bypass_approver: str = "",
) -> bool:
    if status in ALLOW_STATUSES:
        return True
    if emergency_bypass_enabled:
        if not bypass_reason or not bypass_approver:
            return False
        return True
    return False


def guard_event(event: str, status: str, **bypass: Any) -> dict[str, Any]:
    allowed = can_finalize(status, **bypass)
    if event not in BLOCKED_EVENTS:
        return {"event": event, "blocked": False, "allowed": True}
    return {
        "event": event,
        "blocked": not allowed,
        "allowed": allowed,
        "reason": (
            "Quality gate has not approved this artifact"
            if not allowed
            else "Quality gate or documented admin bypass permits this event"
        ),
    }
