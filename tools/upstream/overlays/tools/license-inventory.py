#!/usr/bin/env python3
"""Inventory declared dependency licenses without installing dependencies."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import tomllib
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCKS = ["package-lock.json", "ops/document-editor/package-lock.json", "ops/file-runtime/package-lock.json"]
PYTHON_LOCK = "ops/file-runtime/requirements.lock"
CARGO_LOCK = "ops/execution/native/Cargo.lock"


def read_json(path):
    return json.loads((ROOT / path).read_text())


def fetch_metadata(entry):
    try:
        request = urllib.request.Request(entry["metadataUrl"], headers={"User-Agent": "Zigent-License-Inventory/0.1"})
        with urllib.request.urlopen(request, timeout=20) as response:
            document = json.load(response)
        info = document["info"] if entry["ecosystem"] == "pypi" else document["version"]
        expression = info.get("license_expression") or info.get("license")
        entry["license"] = str(expression).strip() if expression else None
        if not expression and entry["ecosystem"] == "pypi":
            entry["licenseClassifiers"] = [x for x in info.get("classifiers", []) if x.startswith("License ::")]
        entry["metadataStatus"] = "retrieved"
    except urllib.error.HTTPError as error:
        entry["metadataStatus"] = "http_" + str(error.code)
    except (OSError, ValueError, KeyError):
        entry["metadataStatus"] = "unavailable"
    return entry


def requires_review(license_text):
    return not license_text or bool(re.search(r"AGPL|LGPL|GPL|MPL|commercial|proprietary", license_text, re.I))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh-registry", action="store_true", help="Read exact locked versions from public PyPI/crates.io metadata")
    args = parser.parse_args()
    entries = []
    for lock in LOCKS:
        for path, package in sorted(read_json(lock)["packages"].items()):
            if not path:
                continue
            name = package.get("name") or path.rsplit("node_modules/", 1)[-1]
            entries.append({"ecosystem": "npm", "name": name, "version": package.get("version"),
                "license": package.get("license"), "scope": lock, "dev": bool(package.get("dev")),
                "optional": bool(package.get("optional")), "metadataStatus": "lockfile",
                "metadataUrl": "https://registry.npmjs.org/" + urllib.parse.quote(name, safe="") + "/" + str(package.get("version", ""))})
    optional = []
    for name, version in re.findall(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)", (ROOT / PYTHON_LOCK).read_text(), re.M):
        optional.append({"ecosystem": "pypi", "name": name, "version": version, "license": None, "scope": PYTHON_LOCK,
            "metadataStatus": "not_refreshed", "metadataUrl": f"https://pypi.org/pypi/{urllib.parse.quote(name)}/{urllib.parse.quote(version)}/json"})
    for package in tomllib.loads((ROOT / CARGO_LOCK).read_text())["package"]:
        if not package.get("source", "").startswith("registry+"):
            continue
        name, version = package["name"], package["version"]
        optional.append({"ecosystem": "cargo", "name": name, "version": version, "license": None, "scope": CARGO_LOCK,
            "metadataStatus": "not_refreshed", "metadataUrl": f"https://crates.io/api/v1/crates/{urllib.parse.quote(name)}/{urllib.parse.quote(version)}"})
    report_path = ROOT / "docs/dependency-inventory.json"
    previous = json.loads(report_path.read_text()) if report_path.exists() else {}
    previous_entries = {(x["ecosystem"], x["name"], x["version"]): x for x in previous.get("dependencies", [])}
    if args.refresh_registry:
        with ThreadPoolExecutor(max_workers=3) as pool:
            optional = list(pool.map(fetch_metadata, optional))
        registry_checked_at = datetime.now(timezone.utc).date().isoformat()
    else:
        for entry in optional:
            cached = previous_entries.get((entry["ecosystem"], entry["name"], entry["version"]))
            if cached:
                for key in ["license", "licenseClassifiers", "metadataStatus"]:
                    if key in cached:
                        entry[key] = cached[key]
        registry_checked_at = previous.get("registryCheckedAt")
    entries += optional
    entries.sort(key=lambda x: (x["ecosystem"], x["scope"], x["name"].lower(), x["version"] or ""))
    for entry in entries:
        entry["needsDistributionReview"] = requires_review(entry.get("license"))
    counts = dict(Counter(x["ecosystem"] for x in entries))
    missing = sum(not x.get("license") for x in entries)
    sources = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in LOCKS + [PYTHON_LOCK, CARGO_LOCK]}
    report = {"schemaVersion": 1, "registryCheckedAt": registry_checked_at, "kind": "declared metadata inventory; not a legal clearance or complete binary SBOM",
        "sourceSha256": sources, "summary": {"dependencyEntries": len(entries), "byEcosystem": counts,
            "missingLicenseExpressions": missing, "entriesNeedingDistributionReview": sum(x["needsDistributionReview"] for x in entries)}, "dependencies": entries}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    lines = ["# 第三方依赖声明盘点", "", "从锁文件读取实际版本；npm 使用锁文件中的许可声明，Python/Rust 使用精确版本的公开注册表元数据。", "",
        "这是声明盘点，不是完整二进制 SBOM 或法律放行。平台可选包、开发依赖和不同锁文件中的重复项分别记录；未声明的许可与带有分发条件的声明均需要继续核对。", "",
        "| 生态 | 依赖条目 |", "| --- | ---: |"]
    lines += [f"| {name} | {count} |" for name, count in sorted(counts.items())]
    lines += ["", f"未取得许可表达式：**{missing}** 条。注册表核对日期：{registry_checked_at or '尚未联网核对'}。", "",
        "## 需要额外核对的声明", "", "| 依赖 | 版本 | 声明或状态 | 范围 |", "| --- | --- | --- | --- |"]
    selected = {}
    for entry in entries:
        if entry["needsDistributionReview"]:
            key = (entry["ecosystem"], entry["name"], entry["version"])
            selected.setdefault(key, entry)
    for entry in selected.values():
        license_text = entry.get("license") or "未取得表达式（" + entry["metadataStatus"] + "）"
        license_text = " ".join(license_text.split()).replace("|", "\\|")
        if len(license_text) > 180:
            license_text = license_text[:177] + "...（完整声明见 JSON）"
        lines.append(f"| {entry['name']} | {entry['version']} | {license_text} | {entry['ecosystem']} |")
    lines += ["", "## 审核与维护", "", "- 完整条目、元数据来源和锁文件哈希见 [dependency-inventory.json](dependency-inventory.json)。",
        "- 根项目许可证、PyMuPDF、libvips、原生依赖、字体与预构建产物见 [许可证决策说明](LICENSING.md)。",
        "- 更新锁文件后运行 `python3 tools/license-inventory.py --refresh-registry`；不加参数会保留已有精确版本的注册表结果，新增版本会标记为待核对。",
        "- 本脚本不安装依赖，不读取账号凭据，也不自动修改任何许可证。", ""]
    (ROOT / "docs/DEPENDENCIES.md").write_text("\n".join(lines))
    print(json.dumps(report["summary"]))


if __name__ == "__main__":
    main()
