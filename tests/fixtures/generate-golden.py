#!/usr/bin/env python3
"""Generate golden fixtures for the TypeScript port of parse_standard_code().

Runs the ORIGINAL Python parser from the parse_data repo on a fixed sample
set and writes, next to this script:

  - code-parser-golden.json      [{input, expected, divergence?}]

`expected` is the full Python parser output. Cases where the TypeScript
port INTENTIONALLY differs (user decision 2026-11-23: amendment/corrigendum
recognition with or without a space, COR marker) carry a `divergence`
object {reason, ts_fields}; the TS test asserts Python equality for all
fields except those in ts_fields, which must equal the stated TS values.
The Python parser itself is never modified.

The shared merge-key fixture (code-normalize-shared.json) is generated
from the TypeScript parser instead — see generate-shared.ts — because
normalized_code is now built from org_prefix by TS-side logic
(buildNormalizedCode), and elib is the source of truth for the key.

Usage:
  python3 generate-golden.py
  PARSE_DATA_DIR=/path/to/parse_data python3 generate-golden.py

Do NOT hand-edit the generated JSON; regenerate instead.
"""

import json
import os
import sys
from decimal import Decimal
from pathlib import Path

PARSE_DATA_DIR = Path(
    os.environ.get("PARSE_DATA_DIR", Path.home() / "workspace" / "parse_data_pipeline")
)
sys.path.insert(0, str(PARSE_DATA_DIR))

from src.parsers.std_code_parser import parse_standard_code  # noqa: E402

SAMPLES = [
    # --- basics (task minimum set) ---
    "TCVN 9143:2022",
    "TCVN 9143:2012",
    "TCVN 9386-1:2012",
    "TCVN9386",
    "ISO 9001:2015",
    "tcvn 9386-1",
    # --- combined / special orgs ---
    "BS EN ISO 9001:2015",
    "BS EN 13146-3:2019",
    "GB/T 19001-2016",
    "GB/Z 12345:2020",
    "TCVN ISO 9001:2015",
    "TCVN EN 1992-1-1:2022",
    "DIN EN 1090-2:2018",
    "EN ISO 1234:2020",
    "DIN ISO 9001:2015",
    "TCVN/ISO 9001:2015",
    "QCVN 02:2021/BXD",
    # --- part ranges / lists / bare hyphen ---
    "BS EN 13146-1 đến 10:2019",
    "EN 13481 (các phần 1, 2, 5, 6, 7)",
    "EN 1993-1-10:2005",
    "TCVN 13566:2022 (các phần 1-6)",
    "TCVN 13566 (từ 1 đến 10, 2019)",
    "TCVN 13566-1,2,3,4,5:2022",
    "TCVN 13566-1, 2, 3, 4 và 5:2022",
    "TCVN 13566 từ 1 đến 10:2019",
    "TCVN 1234:2020 (phần 1 đến 3)",
    "TCVN 1234:2020 (các phần 1, 3, 5)",
    "TCVN 13566 (-1 đến 10, 2019)",
    "TCVN 1234-1 đến 200:2020",
    "TCVN 7447-4-41:2010",
    # --- amendment / suffix / year forms (from parse_data tests) ---
    "EN 1994-1-1:2004/AC:2009",
    "TCCS 37:2022/TCĐBVN",
    "ISO 231123-1/AC:2009",
    "ISO 9001:2015/AMD1:2016",
    "ISO 9001:2015/Amd 1:2016",
    "ISO 9001:2015/Cor 1:2019",
    "ISO 9001:2015/COR1:2019",
    "EN 1994-1-1:2004/Amd 1:2010",
    "EN 1994-1-1:2004+A1:2010",
    "IEC 60850/2007-02",
    "EN 50122-1-2011",
    "GB 50157-2003",
    "EN 1337-1/2011",
    "EN 50172/2004",
    "TCVN 1234-1 2013",
    # --- equivalents in parentheses ---
    "TCVN 13695 (BS EN 13146-1 đến 10:2019)",
    "TCVN 13695-1:2023 (BS EN 13146-1:2019)",
    "TCVN 9386-1:2012 (ISO 3010:2001)",
    "TCVN 13695-1:2023 (BS EN 13146-1:2019",
    # --- series letter / decimal main / short year / no space ---
    "JIS E 1102",
    "ASTM D 4719-07",
    "AASHTO T27-99",
    "GBJ 22-87",
    "JIS B8009-12",
    "IEEE 802.11",
    "ASME B1.20.7",
    "IEC62278:2002",
    "JISC1731-2",
    "ASTM C172-04",
    "EN 301489-18",
    "Ulc 779-9",
    # --- no-year codes ---
    "TCVN 4756",
    "EN 50129",
    "IEC 60529",
    # --- invalid year-position tokens (from parse_data tests) ---
    "ISO 231123-1:1231",
    "ISO 231123-1/1231",
    "ISO 231123-1:1231/AC:2009",
    "TCVN 1234 1231",
    "TCVN 1234 12",
    "TCVN 9143:1800",
    "XYZ 999:1800",
    # --- version notes / misc real forms ---
    "TCVN 1234:2020 (rev 1)",
    "TCVN 13566 (2019)",
    "TCVN 13566:2020 (2019)",
    "TCVN  9366-1: 2012",
    "TCVN 7161-\n13:2024",
    "ENEN 1234:2020",
    "EN EN 1234:2020",
    "IEEE Std 802.11:2020",
    # --- garbage / unparseable ---
    "",
    "abc",
    "12345",
    "TCVN",
    "???",
    "INVALID STRING",
    "XYZ Q",
]


# Intentional TS-only divergences (user decision 2026-11-23). The Python
# parser is NOT modified; ts_fields states the values the TS port must
# produce for these inputs. Confidence: org 0.2 + main 0.3 + year 0.3
# + suffix 0.1 = 0.9 once the amendment is recognized.
_AMENDMENT_RECOGNIZED = {
    "reason": (
        "TS nhận dạng amendment/corrigendum có hoặc không khoảng trắng "
        "(Amd/Cor) và chuẩn hóa về dạng gọn; Python bỏ suffix nhiều từ "
        "nên mất amendment. Chủ ý khác Python theo quyết định 2026-11-23."
    ),
}
_COR_RECOGNIZED = {
    "reason": (
        "TS nhận dạng COR là corrigendum; regex amendment của Python "
        "không có COR nên amendment=null. Chủ ý khác Python theo quyết "
        "định 2026-11-23."
    ),
}

DIVERGENCES = {
    "ISO 9001:2015/Amd 1:2016": {
        **_AMENDMENT_RECOGNIZED,
        "ts_fields": {
            "suffix": "AMD1:2016",
            "amendment": "AMD1:2016",
            "confidence_score": 0.9,
            "confidence_breakdown": {"org": 0.2, "main": 0.3, "year": 0.3, "suffix": 0.1},
            "verified": True,
        },
    },
    "ISO 9001:2015/Cor 1:2019": {
        **_AMENDMENT_RECOGNIZED,
        "ts_fields": {
            "suffix": "COR1:2019",
            "amendment": "COR1:2019",
            "confidence_score": 0.9,
            "confidence_breakdown": {"org": 0.2, "main": 0.3, "year": 0.3, "suffix": 0.1},
            "verified": True,
        },
    },
    "ISO 9001:2015/COR1:2019": {
        **_COR_RECOGNIZED,
        "ts_fields": {
            "amendment": "COR1:2019",
        },
    },
    "EN 1994-1-1:2004/Amd 1:2010": {
        **_AMENDMENT_RECOGNIZED,
        "ts_fields": {
            "suffix": "AMD1:2010",
            "amendment": "AMD1:2010",
            "confidence_score": 1.0,
            "confidence_breakdown": {
                "org": 0.2,
                "main": 0.3,
                "year": 0.3,
                "parts": 0.1,
                "suffix": 0.1,
            },
            "verified": True,
        },
    },
}


def json_default(obj):
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError(f"not JSON serializable: {type(obj).__name__}")


def main() -> None:
    here = Path(__file__).resolve().parent
    golden = []
    for raw in SAMPLES:
        parsed = parse_standard_code(raw)
        case = {"input": raw, "expected": parsed}
        if raw in DIVERGENCES:
            case["divergence"] = DIVERGENCES[raw]
        golden.append(case)

    (here / "code-parser-golden.json").write_text(
        json.dumps(golden, ensure_ascii=False, indent=2, default=json_default) + "\n",
        encoding="utf-8",
    )
    print(f"golden: {len(golden)} cases, divergences: {len(DIVERGENCES)}")


if __name__ == "__main__":
    main()
