#!/usr/bin/env python3
"""Stable bridge for calling TauricResearch/TradingAgents as an external opinion.

This bridge deliberately keeps TradingAgents outside alpha's scoring and
backtesting loop. It writes an `external_opinion.json` result for manual,
explicit user-triggered TA runs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import webbrowser
from html import escape
from pathlib import Path
from typing import Any


def alpha_data_home() -> Path:
    return Path(os.environ.get("ALPHA_DATA_HOME", Path.home() / ".codex" / "alpha")).expanduser()


def default_repo() -> Path:
    return alpha_data_home() / "tools" / "TradingAgents"


def default_python(repo: Path) -> Path:
    return repo / ".venv" / "bin" / "python"


def default_env_file() -> Path:
    return alpha_data_home() / "secrets" / "tradingagents.env"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_log(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(text.rstrip() + "\n")


def has_llm_credentials(provider: str) -> bool:
    provider = provider.lower()
    key_map = {
        "openai": ["OPENAI_API_KEY"],
        "google": ["GOOGLE_API_KEY"],
        "anthropic": ["ANTHROPIC_API_KEY"],
        "deepseek": ["DEEPSEEK_API_KEY"],
        "qwen": ["DASHSCOPE_API_KEY", "DASHSCOPE_CN_API_KEY"],
        "glm": ["ZHIPU_API_KEY", "ZHIPU_CN_API_KEY"],
        "minimax": ["MINIMAX_API_KEY", "MINIMAX_CN_API_KEY"],
        "openrouter": ["OPENROUTER_API_KEY"],
    }
    if provider == "ollama":
        return True
    return any(os.environ.get(key) for key in key_map.get(provider, []))


def map_symbol(symbol: str, market: str) -> str:
    """Map alpha-style tickers to TradingAgents/Yahoo-style tickers."""
    raw = symbol.strip()
    upper = raw.upper()
    if re.fullmatch(r"\d{6}\.SH", upper):
        return upper.replace(".SH", ".SS")
    if re.fullmatch(r"\d{5}\.HK", upper):
        return f"{int(upper.split('.')[0])}.HK"
    return upper


def extract_rating(text: str | None) -> str | None:
    if not text:
        return None
    patterns = [
        r"\*\*Rating\*\*\s*:\s*([A-Za-z]+)",
        r"Rating\s*:\s*([A-Za-z]+)",
        r"Recommendation\s*:\s*([A-Za-z]+)",
    ]
    for pattern in patterns:
        m = re.search(pattern, text, flags=re.IGNORECASE)
        if m:
            return m.group(1)
    return None


def extract_markdown_value(text: str | None, label: str) -> str:
    if not text:
        return ""
    pattern = rf"\*\*{re.escape(label)}\*\*\s*:\s*(.+?)(?:\n\n|\Z)"
    m = re.search(pattern, text, flags=re.IGNORECASE | re.DOTALL)
    if not m:
        return ""
    return " ".join(m.group(1).strip().split())


def extract_first(patterns: list[str], text: str | None) -> str:
    if not text:
        return ""
    for pattern in patterns:
        m = re.search(pattern, text, flags=re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return ""


def strip_markdown(text: str | None) -> str:
    if not text:
        return ""
    return re.sub(r"\*\*(.*?)\*\*", r"\1", text).strip()


def rating_class(rating: str | None) -> str:
    value = (rating or "").lower()
    if value in {"buy", "strong buy", "overweight", "outperform"}:
        return "positive"
    if value in {"sell", "underweight", "underperform"}:
        return "negative"
    return "neutral"


FIELD_LABELS = {
    "final_trade_decision": "最终交易决策",
    "processed_decision": "处理后的决策摘要",
    "trader_investment_decision": "交易员投资决策",
    "investment_plan": "投资计划",
    "market_report": "市场与技术分析",
    "fundamentals_report": "基本面分析",
    "sentiment_report": "情绪分析",
    "news_report": "新闻与宏观分析",
    "investment_debate_state": "投资辩论状态",
    "risk_debate_state": "风险辩论状态",
    "company_of_interest": "TA 标的代码",
    "trade_date": "TA 交易日",
    "bull_history": "多方论证",
    "bear_history": "空方论证",
    "aggressive_history": "进攻派论证",
    "conservative_history": "保守派论证",
    "neutral_history": "中性派论证",
    "history": "完整辩论历史",
    "current_response": "当前回应",
    "judge_decision": "裁判结论",
}


def field_label(key: str) -> str:
    return FIELD_LABELS.get(key, key.replace("_", " "))


def section_anchor(key: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", key.lower()).strip("-")
    return f"ta-{slug or 'section'}"


def format_inline(text: str) -> str:
    safe = escape(text)
    safe = re.sub(r"`([^`]+)`", r"<code>\1</code>", safe)
    safe = re.sub(r"\*\*(.*?)\*\*", r"<strong>\1</strong>", safe)
    safe = re.sub(r"\*([^*\n]+)\*", r"<em>\1</em>", safe)
    return safe


def split_table_row(line: str) -> list[str]:
    stripped = line.strip().strip("|")
    return [cell.strip() for cell in stripped.split("|")]


def is_table_separator(line: str) -> bool:
    cells = split_table_row(line)
    if not cells:
        return False
    return all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells)


def render_markdown_table(rows: list[str]) -> str:
    if len(rows) < 2:
        return ""
    headers = split_table_row(rows[0])
    body_rows = [split_table_row(row) for row in rows[2:]]
    header_html = "".join(f"<th>{format_inline(cell)}</th>" for cell in headers)
    body_html = []
    for row in body_rows:
        padded = row + [""] * max(0, len(headers) - len(row))
        body_html.append("<tr>" + "".join(f"<td>{format_inline(cell)}</td>" for cell in padded[: len(headers)]) + "</tr>")
    return (
        '<div class="table-wrap"><table>'
        f"<thead><tr>{header_html}</tr></thead>"
        f"<tbody>{''.join(body_html)}</tbody>"
        "</table></div>"
    )


def markdownish_to_html(text: str | None) -> str:
    if not text:
        return "<p class=\"muted\">无正文输出。</p>"
    blocks: list[str] = []
    paragraph: list[str] = []
    list_type: str | None = None
    lines = text.splitlines()
    i = 0

    def close_paragraph() -> None:
        nonlocal paragraph
        if paragraph:
            blocks.append("<p>" + "<br>".join(paragraph) + "</p>")
            paragraph = []

    def close_list() -> None:
        nonlocal list_type
        if list_type:
            blocks.append(f"</{list_type}>")
            list_type = None

    while i < len(lines):
        raw_line = lines[i]
        line = raw_line.strip()
        if not line:
            close_paragraph()
            close_list()
            i += 1
            continue

        if (
            line.startswith("|")
            and i + 1 < len(lines)
            and lines[i + 1].strip().startswith("|")
            and is_table_separator(lines[i + 1].strip())
        ):
            close_paragraph()
            close_list()
            table_rows = [line, lines[i + 1].strip()]
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                table_rows.append(lines[i].strip())
                i += 1
            blocks.append(render_markdown_table(table_rows))
            continue

        heading = re.match(r"^(#{1,4})\s+(.*)$", line)
        if heading:
            close_paragraph()
            close_list()
            level = min(3 + len(heading.group(1)) - 1, 5)
            blocks.append(f"<h{level}>{format_inline(heading.group(2))}</h{level}>")
            i += 1
            continue

        if re.fullmatch(r"[-*_]{3,}", line):
            close_paragraph()
            close_list()
            blocks.append("<hr>")
            i += 1
            continue

        numbered = re.match(r"^\d+\.\s+(.*)$", line)
        bullet = re.match(r"^[*-]\s+(.*)$", line)
        if numbered:
            close_paragraph()
            if list_type != "ol":
                close_list()
                blocks.append("<ol>")
                list_type = "ol"
            blocks.append(f"<li>{format_inline(numbered.group(1))}</li>")
        elif bullet:
            close_paragraph()
            if list_type != "ul":
                close_list()
                blocks.append("<ul>")
                list_type = "ul"
            blocks.append(f"<li>{format_inline(bullet.group(1))}</li>")
        else:
            close_list()
            paragraph.append(format_inline(line))
        i += 1

    close_paragraph()
    close_list()
    return "\n".join(blocks)


def metric_card(label: str, value: str | None, sub: str = "", klass: str = "", compact: bool = False) -> str:
    shown = value if value not in (None, "") else "-"
    size = " compact" if compact else ""
    return (
        f"<section class=\"metric {klass}{size}\">"
        f"<div class=\"metric-label\">{escape(label)}</div>"
        f"<div class=\"metric-value\">{escape(str(shown))}</div>"
        f"<div class=\"metric-sub\">{escape(sub)}</div>"
        "</section>"
    )


def load_raw_state(result: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    raw_path = (result.get("raw_artifacts") or {}).get("raw_state")
    if not raw_path:
        return None, "external_opinion.json 未记录 raw_state 路径。"
    try:
        path = Path(str(raw_path)).expanduser()
        return json.loads(path.read_text(encoding="utf-8")), ""
    except Exception as exc:  # noqa: BLE001
        return None, f"raw_state 读取失败：{exc}"


def latest_logged_state(raw_state: dict[str, Any] | None) -> tuple[str, dict[str, Any]]:
    if not raw_state:
        return "", {}
    state_log = raw_state.get("state_log")
    if not isinstance(state_log, dict) or not state_log:
        return "", {}
    keys = sorted(str(key) for key in state_log.keys())
    latest_key = keys[-1]
    latest = state_log.get(latest_key)
    return latest_key, latest if isinstance(latest, dict) else {}


def render_value(value: Any) -> str:
    if value in (None, ""):
        return '<p class="muted">无内容。</p>'
    if isinstance(value, str):
        return markdownish_to_html(value)
    if isinstance(value, dict):
        if not value:
            return '<p class="muted">空对象。</p>'
        parts = ['<div class="field-stack">']
        for key, nested in value.items():
            parts.append(
                '<div class="field-block">'
                f'<div class="field-title">{escape(field_label(str(key)))}</div>'
                f'<div class="body-copy">{render_value(nested)}</div>'
                "</div>"
            )
        parts.append("</div>")
        return "".join(parts)
    if isinstance(value, list):
        if not value:
            return '<p class="muted">空列表。</p>'
        items = []
        for item in value:
            if isinstance(item, (dict, list)):
                items.append(f'<li><pre class="raw-block">{escape(json.dumps(item, ensure_ascii=False, indent=2))}</pre></li>')
            else:
                items.append(f"<li>{format_inline(str(item))}</li>")
        return '<ul class="plain-list">' + "".join(items) + "</ul>"
    return f'<pre class="raw-block">{escape(json.dumps(value, ensure_ascii=False, indent=2))}</pre>'


def collect_ta_sections(result: dict[str, Any], raw_state: dict[str, Any] | None, state: dict[str, Any]) -> list[dict[str, Any]]:
    raw_state = raw_state or {}
    sections: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(key: str, value: Any, origin: str) -> None:
        if value in (None, "", {}, []):
            return
        sections.append({
            "key": key,
            "label": field_label(key),
            "anchor": section_anchor(key),
            "value": value,
            "origin": origin,
        })
        seen.add(key)

    add("final_trade_decision", state.get("final_trade_decision") or raw_state.get("final_trade_decision") or result.get("summary"), "state.final_trade_decision")
    add("processed_decision", raw_state.get("processed_decision") or result.get("processed_decision"), "raw_state.processed_decision")
    for key in [
        "trader_investment_decision",
        "investment_plan",
        "market_report",
        "fundamentals_report",
        "sentiment_report",
        "news_report",
        "investment_debate_state",
        "risk_debate_state",
    ]:
        add(key, state.get(key), f"state.{key}")

    metadata_keys = {"company_of_interest", "trade_date"}
    for key, value in state.items():
        if key not in seen and key not in metadata_keys:
            add(str(key), value, f"state.{key}")
    return sections


def render_output_section(index: int, section: dict[str, Any]) -> str:
    return (
        f'<article class="report-section" id="{escape(section["anchor"])}">'
        '<div class="section-head">'
        f'<div class="section-index">{index:02d}</div>'
        '<div>'
        f'<h2>{escape(str(section["label"]))}</h2>'
        f'<div class="section-meta">{escape(str(section["origin"]))}</div>'
        "</div>"
        "</div>"
        f'<div class="body-copy">{render_value(section["value"])}</div>'
        "</article>"
    )


def artifact_href(value: str, html_path: str | None) -> str:
    path = Path(value).expanduser()
    html_dir = Path(html_path).expanduser().parent if html_path else None
    try:
        if html_dir and path.resolve().parent == html_dir.resolve():
            return path.name
        if path.exists():
            return path.resolve().as_uri()
    except Exception:
        pass
    return value


def render_artifact_links(artifacts: dict[str, Any]) -> str:
    html_path = str(artifacts.get("html_report") or "")
    links = []
    for label, key in [
        ("HTML 报告", "html_report"),
        ("JSON 结果", "external_opinion"),
        ("完整 raw_state", "raw_state"),
        ("运行日志", "run_log"),
        ("请求记录", "request"),
    ]:
        value = artifacts.get(key)
        if value:
            links.append(f'<a href="{escape(artifact_href(str(value), html_path))}">{escape(label)}</a>')
    return "".join(links) or '<span class="muted">无额外产物链接。</span>'


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def html2canvas_script_tag() -> str:
    source_path = repo_root() / "node_modules" / "html2canvas" / "dist" / "html2canvas.min.js"
    if not source_path.exists():
        return '<script>window.__alphaHtml2CanvasMissing = true;</script>'
    source = source_path.read_text(encoding="utf-8").replace("</script>", "<\\/script>")
    return f"<script>\n{source}\n</script>"


def detect_quality_flags(result: dict[str, Any], state: dict[str, Any], raw_error: str) -> list[str]:
    flags: list[str] = []
    if raw_error:
        flags.append(raw_error)
    name = str(result.get("name") or "").strip()
    combined = "\n".join(str(state.get(key) or "") for key in ["market_report", "news_report", "fundamentals_report"])
    if name and "胜利精密" in combined and "胜利精密" != name:
        flags.append("TA 原始输出中出现“胜利精密”等与输入股票名不一致的称谓；本页面保留原文，不替 TA 修正。")
    if name and state and not any(name in str(state.get(key) or "") for key in ["market_report", "news_report", "fundamentals_report", "final_trade_decision"]):
        flags.append(f"TA 原始报告正文未稳定出现输入股票名称“{name}”，使用前需要核对标的映射。")
    return flags


def share_controls_html() -> str:
    return """<div class="share-actions" data-share-controls>
          <button type="button" class="action-button primary" data-copy-image>
            <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 7h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="1.8"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="1.8"/>
            </svg>
            复制图片
          </button>
          <button type="button" class="action-button" data-download-image>
            <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3v12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              <path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M5 21h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
            下载 PNG
          </button>
          <span class="share-status" data-copy-status>准备就绪</span>
        </div>"""


def copy_image_script() -> str:
    return r"""<script>
(() => {
  const root = document.querySelector("[data-share-root]");
  const copyButton = document.querySelector("[data-copy-image]");
  const downloadButton = document.querySelector("[data-download-image]");
  const statusNode = document.querySelector("[data-copy-status]");
  if (!root || !copyButton || !downloadButton || !statusNode) return;

  function setStatus(text, state = "idle") {
    statusNode.textContent = text;
    statusNode.dataset.state = state;
  }

  function setBusy(busy) {
    copyButton.disabled = busy;
    downloadButton.disabled = busy;
  }

  function imageScale(width, height) {
    const deviceScale = Math.min(window.devicePixelRatio || 1, 2);
    const maxPixels = 48_000_000;
    const maxDimension = 32760;
    const pixelScale = Math.sqrt(maxPixels / Math.max(width * height, 1));
    const dimensionScale = Math.min(maxDimension / Math.max(width, 1), maxDimension / Math.max(height, 1));
    return Math.max(0.4, Math.min(deviceScale, pixelScale, dimensionScale));
  }

  function reportFilename() {
    const name = (document.title || "TradingAgents-report").replace(/[\\/:*?"<>|]+/g, "-").trim();
    return `${name || "TradingAgents-report"}.png`;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PNG 生成失败"));
      }, "image/png", 0.95);
    });
  }

  async function renderReportToPngBlob() {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }

    const width = Math.ceil(root.getBoundingClientRect().width);
    const height = Math.ceil(root.scrollHeight);
    if (!window.html2canvas) {
      throw new Error("html2canvas 未加载，无法生成图片");
    }
    const canvas = await window.html2canvas(root, {
      backgroundColor: "#f4f1ea",
      scale: imageScale(width, height),
      logging: false,
      useCORS: false,
      allowTaint: false,
      width,
      height,
      windowWidth: Math.max(document.documentElement.scrollWidth, width),
      windowHeight: height,
      ignoreElements: (element) => Boolean(element.closest && element.closest("[data-share-controls]")),
      onclone: (clonedDocument) => {
        clonedDocument.querySelectorAll("[data-share-controls]").forEach((node) => node.remove());
        const clonedRoot = clonedDocument.querySelector("[data-share-root]");
        if (clonedRoot) {
          clonedRoot.style.width = `${width}px`;
          clonedRoot.style.maxWidth = "none";
          clonedRoot.style.margin = "0";
        }
      },
    });
    return await canvasToBlob(canvas);
  }

  function downloadBlob(blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = reportFilename();
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function writeClipboard(blob) {
    if (!navigator.clipboard || !window.ClipboardItem) {
      throw new Error("当前浏览器不支持图片剪贴板");
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }

  async function copyImage() {
    setBusy(true);
    setStatus("正在生成图片", "busy");
    try {
      const blob = await renderReportToPngBlob();
      try {
        await writeClipboard(blob);
        setStatus("已复制到剪贴板", "success");
      } catch (clipboardError) {
        console.warn("Clipboard image copy failed; downloading PNG instead.", clipboardError);
        downloadBlob(blob);
        setStatus("复制受限，已下载 PNG", "warning");
      }
    } catch (error) {
      console.error(error);
      setStatus("图片生成失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function downloadImage() {
    setBusy(true);
    setStatus("正在生成图片", "busy");
    try {
      const blob = await renderReportToPngBlob();
      downloadBlob(blob);
      setStatus("PNG 已下载", "success");
    } catch (error) {
      console.error(error);
      setStatus("图片生成失败", "error");
    } finally {
      setBusy(false);
    }
  }

  copyButton.addEventListener("click", copyImage);
  downloadButton.addEventListener("click", downloadImage);
  window.__alphaRenderReportToPngForTest = renderReportToPngBlob;
})();
</script>"""


def build_html_result(result: dict[str, Any]) -> str:
    raw_state, raw_error = load_raw_state(result)
    latest_state_key, state = latest_logged_state(raw_state)
    ta_sections = collect_ta_sections(result, raw_state, state)
    summary = str(result.get("summary") or "")
    rating = result.get("rating") or extract_rating(summary) or result.get("processed_decision") or "-"
    price_target = extract_markdown_value(summary, "Price Target")
    horizon = extract_markdown_value(summary, "Time Horizon")
    target_weight = extract_first([
        r"总目标仓位(?:设为|为|[:：])\s*([0-9]+(?:\.[0-9]+)?%)",
        r"目标仓位(?:设为|为|[:：])\s*([0-9]+(?:\.[0-9]+)?%)",
    ], summary)
    first_batch = extract_first([
        r"第一批[（(]\s*([0-9]+(?:\.[0-9]+)?%?\s*[-~至到]\s*[0-9]+(?:\.[0-9]+)?%|[0-9]+(?:\.[0-9]+)?%)\s*[）)]",
        r"第一批(?:仓位)?(?:为|[:：])\s*([0-9]+(?:\.[0-9]+)?%?\s*[-~至到]\s*[0-9]+(?:\.[0-9]+)?%|[0-9]+(?:\.[0-9]+)?%)",
    ], summary)
    entry_zone = extract_first([
        r"回落至\s*([0-9]+(?:\.[0-9]+)?\s*[-~至到]\s*[0-9]+(?:\.[0-9]+)?\s*元)",
        r"([0-9]+(?:\.[0-9]+)?\s*[-~至到]\s*[0-9]+(?:\.[0-9]+)?\s*元)支撑区间",
    ], summary)
    stop_loss = extract_first([
        r"止损(?:设于|下移至|设在|为|[:：])\s*([0-9]+(?:\.[0-9]+)?\s*元)",
        r"([0-9]+(?:\.[0-9]+)?\s*元)[，,]?\s*以过滤市场噪音",
    ], summary)
    status = str(result.get("status") or "unknown")
    status_class = "positive" if status == "success" else "negative"
    display_name = str(result.get("name") or result.get("symbol") or "TA")
    title = f"{display_name} TradingAgents 深度解读"
    subtitle = (
        f"{result.get('symbol', '')} / {result.get('mapped_symbol', '')} / "
        f"{result.get('trade_date', '')}"
    )
    artifacts = result.get("raw_artifacts") or {}
    data_gaps = result.get("data_gaps") or []
    quality_flags = detect_quality_flags(result, state, raw_error)
    data_gap_html = (
        "<ul>" + "".join(f"<li>{escape(str(item))}</li>" for item in data_gaps) + "</ul>"
        if data_gaps
        else "<p class=\"muted\">本次结构化结果未记录额外数据缺口。运行日志里仍可能包含外部社区、新闻或行情源的降级信息。</p>"
    )
    quality_html = (
        "<ul>" + "".join(f"<li>{escape(item)}</li>" for item in quality_flags) + "</ul>"
        if quality_flags
        else '<p class="muted">未从结构化输出中发现额外完整性告警。</p>'
    )
    failure_html = ""
    if status != "success":
        failure_html = (
            "<article class=\"report-section warning-panel\" id=\"ta-failure\">"
            "<div class=\"section-head\"><div class=\"section-index\">!</div><div><h2>失败原因</h2><div class=\"section-meta\">bridge.failure</div></div></div>"
            f"<p><strong>{escape(str(result.get('failure_reason') or 'unknown'))}</strong></p>"
            f"<pre>{escape(str(result.get('failure_details') or ''))}</pre>"
            "</article>"
        )

    metrics_html = "".join([
        metric_card("TA 评级", str(rating), "独立参考，不写入 alpha 模型", rating_class(str(rating))),
        metric_card("目标价", price_target, "Price Target"),
        metric_card("时间框架", horizon, "Time Horizon"),
        metric_card("建议总仓位", target_weight, "TA 原文抽取"),
        metric_card("第一批", first_batch, "TA 原文抽取"),
        metric_card("运行状态", status, "TradingAgents bridge", status_class),
        metric_card("输出模块", str(len(ta_sections)), "state/report/debate 完整展开"),
        metric_card("raw_state", "已载入" if raw_state else "未载入", latest_state_key or "latest state", "positive" if raw_state else "negative"),
    ])
    price_rail = "".join([
        metric_card("止损位", stop_loss, "风险边界", "negative", compact=True),
        metric_card("入场区", entry_zone, "等待企稳确认", "neutral", compact=True),
        metric_card("目标区", price_target, "上行目标", "positive", compact=True),
    ])
    metadata_items = [
        ("输入标的", f"{display_name} / {result.get('symbol', '-')}" ),
        ("TA 映射", str(result.get("mapped_symbol") or "-")),
        ("TA 记录标的", str(state.get("company_of_interest") or "-")),
        ("交易日", str(result.get("trade_date") or state.get("trade_date") or "-")),
        ("模型", " / ".join(filter(None, [str(result.get("provider") or ""), str(result.get("quick_model") or ""), str(result.get("deep_model") or "")])) or "-"),
        ("生成时间", str(result.get("generated_at") or "-")),
    ]
    metadata_html = "".join(
        f"<div><span>{escape(label)}</span><strong>{escape(value)}</strong></div>"
        for label, value in metadata_items
    )
    sections_html = "\n".join(render_output_section(i + 1, section) for i, section in enumerate(ta_sections))
    nav_html = "".join(
        f'<a href="#{escape(section["anchor"])}"><span>{i + 1:02d}</span>{escape(str(section["label"]))}</a>'
        for i, section in enumerate(ta_sections)
    )
    raw_dump = json.dumps(raw_state, ensure_ascii=False, indent=2) if raw_state else raw_error
    generated_at = escape(str(result.get("generated_at") or ""))
    model_line = " / ".join(filter(None, [
        str(result.get("provider") or ""),
        str(result.get("quick_model") or ""),
        str(result.get("deep_model") or ""),
    ]))
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(title)}</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f4f1ea;
      --bg-2: #eef3f0;
      --ink: #141b24;
      --muted: #66706f;
      --line: #d8d2c4;
      --panel: #fffdfa;
      --panel-2: #f8faf7;
      --positive: #0f766e;
      --negative: #b42318;
      --neutral: #475467;
      --accent: #1d4ed8;
      --amber: #a16207;
      --shadow: 0 18px 48px rgba(20, 27, 36, .08);
    }}
    * {{ box-sizing: border-box; }}
    html {{ scroll-behavior: smooth; }}
    body {{
      margin: 0;
      font-family: "Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      background:
        linear-gradient(90deg, rgba(20, 27, 36, .035) 1px, transparent 1px),
        linear-gradient(0deg, rgba(20, 27, 36, .025) 1px, transparent 1px),
        var(--bg);
      background-size: 36px 36px;
      color: var(--ink);
      line-height: 1.58;
    }}
    .wrap {{
      max-width: 1240px;
      margin: 0 auto;
      padding: 28px 22px 54px;
    }}
    .masthead {{
      display: grid;
      grid-template-columns: minmax(0, 1fr) 260px;
      gap: 14px;
      padding: 28px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }}
    .masthead-main {{
      min-width: 0;
    }}
    .report-meta {{
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px 18px;
      margin-top: 22px;
      padding-top: 18px;
      border-bottom: 1px solid var(--line);
      border-top: 1px solid var(--line);
    }}
    .report-meta div {{
      min-width: 0;
      padding-bottom: 10px;
    }}
    .report-meta span {{
      display: block;
      color: var(--muted);
      font-size: 12px;
    }}
    .report-meta strong {{
      display: block;
      margin-top: 4px;
      font-size: 14px;
      overflow-wrap: anywhere;
    }}
    .eyebrow {{
      font-size: 13px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0;
    }}
    h1 {{
      margin: 0;
      font-size: 40px;
      line-height: 1.1;
      letter-spacing: 0;
    }}
    .subtitle {{
      margin-top: 10px;
      color: var(--muted);
      font-size: 15px;
    }}
    .verdict-card {{
      align-self: stretch;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 20px;
      padding: 18px;
      border-left: 4px solid var(--accent);
      background: var(--panel-2);
      border-radius: 8px;
    }}
    .verdict-card span {{
      color: var(--muted);
      font-size: 13px;
    }}
    .verdict-card strong {{
      display: block;
      margin-top: 6px;
      font-size: 30px;
      line-height: 1.1;
      overflow-wrap: anywhere;
    }}
    .verdict-card strong.positive {{ color: var(--positive); }}
    .verdict-card strong.negative {{ color: var(--negative); }}
    .verdict-card strong.neutral {{ color: var(--neutral); }}
    .notice {{
      margin-top: 14px;
      max-width: 100%;
      padding: 10px 12px;
      border: 1px solid #b7cbc8;
      background: #eef8f6;
      color: #115e59;
      border-radius: 8px;
      font-size: 13px;
    }}
    .share-actions {{
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin-top: 14px;
    }}
    .action-button {{
      appearance: none;
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 0 13px;
      border: 1px solid #b7cbc8;
      border-radius: 8px;
      background: #fffefa;
      color: var(--ink);
      font: inherit;
      font-size: 13px;
      font-weight: 720;
      letter-spacing: 0;
      cursor: pointer;
      transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
    }}
    .action-button.primary {{
      background: #141b24;
      border-color: #141b24;
      color: #fff;
    }}
    .action-button:hover {{
      transform: translateY(-1px);
      border-color: #7f9995;
      box-shadow: 0 8px 18px rgba(20, 27, 36, .10);
    }}
    .action-button:disabled {{
      cursor: progress;
      opacity: .56;
      transform: none;
      box-shadow: none;
    }}
    .button-icon {{
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
    }}
    .share-status {{
      color: var(--muted);
      font-size: 13px;
    }}
    .share-status[data-state="success"] {{ color: var(--positive); }}
    .share-status[data-state="warning"] {{ color: var(--amber); }}
    .share-status[data-state="error"] {{ color: var(--negative); }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 22px 0;
    }}
    .metric {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-height: 118px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }}
    .metric.compact {{ min-height: 96px; }}
    .metric-label {{
      color: var(--muted);
      font-size: 13px;
    }}
    .metric-value {{
      margin-top: 8px;
      font-size: 24px;
      font-weight: 720;
      overflow-wrap: anywhere;
    }}
    .metric-sub {{
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }}
    .metric.positive .metric-value {{ color: var(--positive); }}
    .metric.negative .metric-value {{ color: var(--negative); }}
    .metric.neutral .metric-value {{ color: var(--neutral); }}
    .price-band {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 20px;
      margin: 16px 0 20px;
    }}
    .price-band h2 {{
      margin: 0 0 12px;
      font-size: 20px;
    }}
    .report-layout {{
      display: grid;
      grid-template-columns: 242px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }}
    .side-nav {{
      position: sticky;
      top: 18px;
      background: rgba(255, 253, 250, .88);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      backdrop-filter: blur(10px);
    }}
    .side-nav h2 {{
      margin: 0 0 10px;
      font-size: 14px;
    }}
    .side-nav a {{
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 8px;
      align-items: baseline;
      padding: 8px 0;
      color: var(--ink);
      text-decoration: none;
      border-top: 1px solid rgba(216, 210, 196, .75);
      font-size: 13px;
    }}
    .side-nav a span {{
      color: var(--accent);
      font-variant-numeric: tabular-nums;
    }}
    .report-stack {{
      display: grid;
      gap: 16px;
    }}
    .report-section {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 22px;
      box-shadow: 0 8px 22px rgba(20, 27, 36, .045);
      overflow: hidden;
    }}
    .section-head {{
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr);
      gap: 14px;
      align-items: start;
      margin-bottom: 16px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--line);
    }}
    .section-index {{
      width: 42px;
      height: 42px;
      display: grid;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--accent);
      background: var(--panel-2);
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }}
    .report-section h2 {{
      margin: 0;
      font-size: 20px;
      letter-spacing: 0;
    }}
    .section-meta {{
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }}
    .price-rail {{
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }}
    .body-copy {{
      color: #1f2937;
      font-size: 15px;
    }}
    .body-copy p {{
      margin: 0 0 12px;
    }}
    .body-copy ul, .body-copy ol {{
      padding-left: 22px;
      margin: 8px 0 14px;
    }}
    .body-copy li {{
      margin: 6px 0;
    }}
    .body-copy h3, .body-copy h4, .body-copy h5 {{
      margin: 20px 0 8px;
      line-height: 1.28;
      letter-spacing: 0;
    }}
    .body-copy h3 {{ font-size: 18px; }}
    .body-copy h4 {{ font-size: 16px; }}
    .body-copy h5 {{ font-size: 15px; }}
    .body-copy hr {{
      border: 0;
      border-top: 1px solid var(--line);
      margin: 18px 0;
    }}
    code {{
      padding: 1px 5px;
      border: 1px solid #d7e0e6;
      background: #f4f7f9;
      border-radius: 5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: .92em;
    }}
    .table-wrap {{
      width: 100%;
      overflow-x: auto;
      margin: 12px 0 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      min-width: 640px;
      background: #fff;
      font-size: 14px;
    }}
    th, td {{
      padding: 10px 12px;
      border-bottom: 1px solid #e6e1d5;
      text-align: left;
      vertical-align: top;
    }}
    th {{
      background: #f1f5f4;
      color: #263238;
      font-weight: 700;
    }}
    tr:last-child td {{ border-bottom: 0; }}
    .field-stack {{
      display: grid;
      gap: 16px;
    }}
    .field-block {{
      padding-top: 14px;
      border-top: 1px solid var(--line);
    }}
    .field-block:first-child {{
      padding-top: 0;
      border-top: 0;
    }}
    .field-title {{
      margin-bottom: 8px;
      color: var(--accent);
      font-size: 14px;
      font-weight: 720;
    }}
    .muted {{
      color: var(--muted);
    }}
    pre {{
      overflow: auto;
      white-space: pre-wrap;
      border: 1px solid var(--line);
      background: #f7f8f8;
      border-radius: 6px;
      padding: 12px;
      max-height: 520px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.55;
    }}
    details.raw-details summary {{
      cursor: pointer;
      font-weight: 720;
      color: var(--ink);
      margin-bottom: 12px;
    }}
    .warning-panel {{
      border-color: #e7c9a9;
      background: #fffaf3;
    }}
    .warning-panel .section-index {{
      color: var(--amber);
      border-color: #e7c9a9;
      background: #fff4e5;
    }}
    .links {{
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 8px;
    }}
    .links a {{
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px solid rgba(29, 78, 216, .35);
    }}
    footer {{
      color: var(--muted);
      font-size: 12px;
      margin-top: 22px;
      border-top: 1px solid var(--line);
      padding-top: 16px;
    }}
    @media (max-width: 980px) {{
      .masthead {{ grid-template-columns: 1fr; }}
      .grid {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
      .report-layout {{ grid-template-columns: 1fr; }}
      .side-nav {{ position: static; }}
      .report-meta {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
    }}
    @media (max-width: 680px) {{
      .wrap {{ padding: 18px 12px 36px; }}
      .grid, .price-rail {{ grid-template-columns: 1fr; }}
      .metric {{ min-height: auto; }}
      h1 {{ font-size: 30px; }}
      .report-section, .masthead, .price-band {{ padding: 16px; }}
      .section-head {{ grid-template-columns: 1fr; }}
      .report-meta {{ grid-template-columns: 1fr; }}
      .action-button {{ flex: 1 1 150px; }}
      .share-status {{ width: 100%; }}
    }}
  </style>
</head>
<body>
  <main class="wrap" data-share-root>
    <header class="masthead">
      <div class="masthead-main">
        <div class="eyebrow">TradingAgents research dossier</div>
        <h1>{escape(title)}</h1>
        <div class="subtitle">{escape(subtitle)} · {escape(model_line)}</div>
        <div class="notice">TA 结果只作为独立参考展示，不进入 alpha 的评分、回测、训练、调参、定时任务或自动仓位决策。</div>
        {share_controls_html()}
        <div class="report-meta">{metadata_html}</div>
      </div>
      <aside class="verdict-card">
        <div>
          <span>TradingAgents 评级</span>
          <strong class="{rating_class(str(rating))}">{escape(str(rating))}</strong>
        </div>
        <div class="subtitle">Status: {escape(status)}<br>Generated: {generated_at or "未记录"}</div>
      </aside>
    </header>

    <section class="grid">{metrics_html}</section>

    <section class="price-band">
      <h2>价格与仓位框架</h2>
      <div class="price-rail">{price_rail}</div>
    </section>

    <div class="report-layout">
      <nav class="side-nav" aria-label="TradingAgents 输出目录">
        <h2>输出目录</h2>
        {nav_html}
        <a href="#ta-quality"><span>QA</span>完整性提示</a>
        <a href="#ta-artifacts"><span>FI</span>产物与原始数据</a>
      </nav>
      <div class="report-stack">
        {failure_html}
        {sections_html}
        <article class="report-section warning-panel" id="ta-quality">
          <div class="section-head"><div class="section-index">QA</div><div><h2>完整性与数据质量提示</h2><div class="section-meta">bridge.integrity</div></div></div>
          <div class="body-copy">{quality_html}</div>
          <h3>数据缺口与降级</h3>
          <div class="body-copy">{data_gap_html}</div>
        </article>
        <article class="report-section" id="ta-artifacts">
          <div class="section-head"><div class="section-index">FI</div><div><h2>产物与完整原始状态</h2><div class="section-meta">external_opinion.json / raw_state.json / run.log</div></div></div>
          <div class="links">{render_artifact_links(artifacts)}</div>
          <details class="raw-details">
            <summary>完整 raw_state.json</summary>
            <pre>{escape(raw_dump)}</pre>
          </details>
        </article>
      </div>
    </div>

    <footer>
      生成时间：{generated_at or "未记录"}。本报告由 alpha TA bridge 根据 external_opinion.json 生成。
    </footer>
  </main>
  {html2canvas_script_tag()}
  {copy_image_script()}
</body>
</html>
"""


def open_html(path: Path) -> None:
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", str(path)], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            webbrowser.open(path.as_uri())
    except Exception:
        return


def finalize_result(args: argparse.Namespace, result: dict[str, Any], result_path: Path, request_path: Path) -> None:
    html_path = result_path.with_name("external_opinion.html")
    artifacts = result.setdefault("raw_artifacts", {})
    artifacts["external_opinion"] = str(result_path)
    artifacts["request"] = str(request_path)
    artifacts["html_report"] = str(html_path)
    result.setdefault("generated_at", __import__("datetime").datetime.now().isoformat(timespec="seconds"))
    write_json(result_path, result)
    html_path.write_text(build_html_result(result), encoding="utf-8")
    if not getattr(args, "no_open", False):
        open_html(html_path)


def unavailable_result(args: argparse.Namespace, reason: str, details: str | None = None) -> dict[str, Any]:
    mapped = map_symbol(args.symbol, args.market)
    return {
        "source": "TradingAgents",
        "trigger": "explicit_user_request",
        "alpha_usage": "external_opinion_only",
        "status": "unavailable",
        "failure_reason": reason,
        "failure_details": details or "",
        "symbol": args.symbol,
        "mapped_symbol": mapped,
        "name": args.name,
        "market": args.market,
        "trade_date": args.date,
        "rating": None,
        "summary": "",
        "data_gaps": [details] if details else [],
        "raw_artifacts": {
            "run_log": str(Path(args.out_dir).expanduser() / "run.log"),
        },
    }


def run(args: argparse.Namespace) -> int:
    env_file = Path(args.env_file).expanduser().resolve() if args.env_file else default_env_file()
    load_env_file(env_file)

    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    request_path = out_dir / "request.json"
    result_path = out_dir / "external_opinion.json"
    run_log = out_dir / "run.log"

    repo = Path(args.repo).expanduser().resolve() if args.repo else default_repo()
    py = Path(args.python).expanduser().resolve() if args.python else default_python(repo)
    mapped_symbol = map_symbol(args.symbol, args.market)
    provider = args.provider or os.environ.get("TRADINGAGENTS_LLM_PROVIDER") or "openai"
    quick_model = args.quick_model or os.environ.get("TRADINGAGENTS_QUICK_THINK_LLM") or "gpt-5.4-mini"
    deep_model = args.deep_model or os.environ.get("TRADINGAGENTS_DEEP_THINK_LLM") or "gpt-5.5"
    backend_url = args.backend_url or os.environ.get("TRADINGAGENTS_BACKEND_URL") or os.environ.get("OPENAI_BASE_URL") or ""

    request = {
        "source": "alpha",
        "target": "TradingAgents",
        "trigger": "explicit_user_request",
        "alpha_usage": "external_opinion_only",
        "symbol": args.symbol,
        "mapped_symbol": mapped_symbol,
        "name": args.name,
        "market": args.market,
        "trade_date": args.date,
        "provider": provider,
        "quick_model": quick_model,
        "deep_model": deep_model,
        "backend_url": backend_url,
        "repo": str(repo),
        "python": str(py),
        "env_file": str(env_file),
    }
    write_json(request_path, request)
    append_log(run_log, f"request={request_path}")

    if not repo.exists():
        finalize_result(args, unavailable_result(args, "stable_repo_missing", f"TradingAgents repo not found: {repo}"), result_path, request_path)
        return 0
    if not py.exists():
        finalize_result(args, unavailable_result(args, "stable_python_missing", f"TradingAgents python not found: {py}"), result_path, request_path)
        return 0
    if not has_llm_credentials(provider):
        finalize_result(
            args,
            unavailable_result(
                args,
                "llm_api_key_missing",
                f"No LLM credential found for provider={provider}; configure the provider API key or use an available local provider.",
            ),
            result_path,
            request_path,
        )
        return 0

    runner = f"""
import json
from pathlib import Path
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.default_config import DEFAULT_CONFIG

out_dir = Path({str(out_dir)!r})
config = DEFAULT_CONFIG.copy()
config.update({{
    "llm_provider": {provider!r},
    "quick_think_llm": {quick_model!r},
    "deep_think_llm": {deep_model!r},
    "backend_url": {backend_url or None!r},
    "checkpoint_enabled": True,
    "output_language": {args.output_language!r},
    "results_dir": str(out_dir / "ta_results"),
    "data_cache_dir": str(out_dir / "ta_cache"),
    "memory_log_path": str(out_dir / "ta_memory.md"),
    "max_debate_rounds": {args.max_debate_rounds},
    "max_risk_discuss_rounds": {args.max_risk_rounds},
}})
ta = TradingAgentsGraph(
    selected_analysts={args.analysts!r}.split(","),
    debug=False,
    config=config,
)
state, decision = ta.propagate({mapped_symbol!r}, {args.date!r})
payload = {{
    "final_trade_decision": state.get("final_trade_decision"),
    "processed_decision": decision,
    "state_log": ta.log_states_dict,
}}
(out_dir / "raw_state.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({{"final_trade_decision": state.get("final_trade_decision"), "processed_decision": decision}}, ensure_ascii=False))
"""

    try:
        completed = subprocess.run(
            [str(py), "-c", runner],
            cwd=str(repo),
            text=True,
            capture_output=True,
            timeout=args.max_runtime_minutes * 60,
            env=os.environ.copy(),
        )
    except subprocess.TimeoutExpired as exc:
        append_log(run_log, f"timeout after {args.max_runtime_minutes} minutes")
        finalize_result(args, unavailable_result(args, "timeout", str(exc)), result_path, request_path)
        return 0

    append_log(run_log, "stdout:\n" + (completed.stdout or ""))
    append_log(run_log, "stderr:\n" + (completed.stderr or ""))
    if completed.returncode != 0:
        finalize_result(args, unavailable_result(args, "tradingagents_runtime_error", completed.stderr[-4000:]), result_path, request_path)
        return 0

    try:
        last_line = [line for line in completed.stdout.splitlines() if line.strip()][-1]
        raw = json.loads(last_line)
        final_text = raw.get("final_trade_decision") or ""
    except Exception as exc:  # noqa: BLE001
        finalize_result(args, unavailable_result(args, "parse_error", str(exc)), result_path, request_path)
        return 0

    result = {
        "source": "TradingAgents",
        "trigger": "explicit_user_request",
        "alpha_usage": "external_opinion_only",
        "status": "success",
        "symbol": args.symbol,
        "mapped_symbol": mapped_symbol,
        "name": args.name,
        "market": args.market,
        "trade_date": args.date,
        "provider": provider,
        "quick_model": quick_model,
        "deep_model": deep_model,
        "backend_url": backend_url,
        "rating": extract_rating(final_text),
        "summary": final_text,
        "data_gaps": [],
        "raw_artifacts": {
            "raw_state": str(out_dir / "raw_state.json"),
            "run_log": str(run_log),
        },
    }
    finalize_result(args, result, result_path, request_path)
    return 0


def render(args: argparse.Namespace) -> int:
    result_path = Path(args.result).expanduser().resolve()
    result = json.loads(result_path.read_text(encoding="utf-8"))
    request_path = Path(args.request).expanduser().resolve() if args.request else result_path.with_name("request.json")
    finalize_result(args, result, result_path, request_path)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Call TradingAgents as an explicit external opinion.")
    sub = parser.add_subparsers(dest="command", required=True)
    run_p = sub.add_parser("run")
    run_p.add_argument("--symbol", required=True)
    run_p.add_argument("--name", default="")
    run_p.add_argument("--market", default="")
    run_p.add_argument("--date", required=True)
    run_p.add_argument("--out-dir", required=True)
    run_p.add_argument("--repo", default="")
    run_p.add_argument("--python", default="")
    run_p.add_argument("--env-file", default="")
    run_p.add_argument("--provider", default="")
    run_p.add_argument("--quick-model", default="")
    run_p.add_argument("--deep-model", default="")
    run_p.add_argument("--backend-url", default="")
    run_p.add_argument("--output-language", default="Chinese")
    run_p.add_argument("--analysts", default="market,social,news,fundamentals")
    run_p.add_argument("--max-debate-rounds", type=int, default=1)
    run_p.add_argument("--max-risk-rounds", type=int, default=1)
    run_p.add_argument("--max-runtime-minutes", type=int, default=30)
    run_p.add_argument("--no-open", action="store_true")
    run_p.set_defaults(func=run)

    render_p = sub.add_parser("render")
    render_p.add_argument("--result", required=True)
    render_p.add_argument("--request", default="")
    render_p.add_argument("--no-open", action="store_true")
    render_p.set_defaults(func=render)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
