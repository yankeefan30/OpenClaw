"""Drive archival contract for quality-gate artifacts."""

from __future__ import annotations

from pathlib import PurePosixPath
from typing import Any


ROOT = "The Artist"


def quality_review_paths(deck_name: str) -> dict[str, str]:
    reviews = PurePosixPath(ROOT) / "07_Quality Reviews"
    specs = PurePosixPath(ROOT) / "08_JSON Specifications"
    working = PurePosixPath(ROOT) / "03_Working Decks"
    pptx = PurePosixPath(ROOT) / "04_Final PPTX"
    pdf = PurePosixPath(ROOT) / "05_Final PDF"
    return {
        "working_deck": str(working / f"{deck_name}_working"),
        "quality_gate_report": str(reviews / f"{deck_name}_pre-board-quality-gate.json"),
        "revision_log": str(reviews / f"{deck_name}_revision-log.json"),
        "board_readiness_summary": str(reviews / f"{deck_name}_board-readiness-summary.md"),
        "revised_spec": str(specs / f"{deck_name}_revised-presentation-spec.json"),
        "final_pptx": str(pptx / f"{deck_name}.pptx"),
        "final_pdf": str(pdf / f"{deck_name}.pdf"),
    }


def archive_plan(deck_name: str, *, finalization_allowed: bool) -> dict[str, Any]:
    paths = quality_review_paths(deck_name)
    return {
        "folder_tree": paths,
        "write_now": [
            paths["quality_gate_report"],
            paths["revision_log"],
            paths["board_readiness_summary"],
            paths["revised_spec"],
        ]
        if finalization_allowed
        else [
            paths["quality_gate_report"],
            paths["revision_log"],
            paths["revised_spec"],
        ],
        "write_only_after_user_approval": [
            paths["final_pptx"],
            paths["final_pdf"],
            paths["working_deck"],
        ],
        "requires_user_approval": True,
    }


def board_readiness_summary_markdown(report: dict[str, Any], artifact_name: str) -> str:
    gate = report["pre_board_quality_gate"]
    lines = [
        f"# Board-readiness summary — {artifact_name}",
        "",
        f"- Status: **{gate['status']}**",
        f"- Overall: {gate['overall_score_out_of_10']}/10",
        f"- Board readiness: {gate['board_readiness_score_out_of_10']}/10",
        f"- Executive summary: {gate['executive_summary_score_out_of_10']}/10",
        f"- Decision clarity: {gate['decision_clarity_score_out_of_10']}/10",
        f"- Source integrity: {gate['source_integrity_score_out_of_10']}/10",
        "",
        "## Approval rationale",
        gate.get("approval_rationale") or "Not yet approved.",
        "",
        "## Material issues",
    ]
    issues = gate.get("material_issues") or ["None"]
    lines.extend(f"- {item}" for item in issues)
    lines.extend(["", "## Unresolved questions"])
    questions = gate.get("unresolved_questions") or ["None"]
    lines.extend(f"- {item}" for item in questions)
    return "\n".join(lines) + "\n"
