"""Browser-only account-link recovery fixtures; no real accounts or network providers."""

from pathlib import Path
import json
import os
import time
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CANDIDATES = {
    "cli": "assets/kagnode-account.js",
    "authenticator": "authentactor/static/kagnode-account.js",
    "mail": "kagnode/static/kagnode-account.js",
    "vpn": "web/kagnode-account.js",
    "httpboot": "web/kagnode-account.js",
    "media": "public/kagnode-account.js",
}
APP = next(
    app
    for app, name in CANDIDATES.items()
    if (ROOT / name).exists()
    and (app != "vpn" or (ROOT / "src/vpn_account_sync.py").exists())
    and (app != "httpboot" or (ROOT / "httpboot/account_sync.py").exists())
)
SOURCE = ROOT / CANDIDATES[APP]
APPS = os.environ.get("KAGNODE_ACCOUNT_TEST_APPS", APP).split(",")
ENGINES = [os.environ.get("KAGNODE_BROWSER_ENGINE", "chromium")]
BASE = {
    "enabled": True,
    "connected": False,
    "admin": False,
    "profile": None,
    "local_name": "Local fixture",
    "warning": "",
    "configured_off": False,
    "revocations_pending": 0,
    "pending": False,
}
PENDING = {
    **BASE,
    "pending": True,
    "user_code": "ABCDE-12345",
    "verification_uri": "https://nebulacoder.com/account/apps/device?code=ABCDE12345",
    "interval": 5,
    "expires_in": 500,
    "attempt_id": "1:1",
}
LINKED = {**BASE, "connected": True, "profile": {"name": "Linked fixture", "photo": ""}}
failures = []
report = []


def run_case(browser, engine, app, width, case):
    state = dict(PENDING if case in ["resume", "late-poll"] else BASE)
    counts = {"start": 0, "poll": 0, "cancel": 0, "get": 0}
    if case.startswith("update-"):
        state["admin"] = True
    if case == "late-policy":
        state.update(enabled=False, admin=True)
    update = {
        "enabled": True,
        "kind": "python",
        "installed": "1.0",
        "channel": "preview",
        "can_apply": case in ("update-ready", "update-legacy-ready"),
        "needs_recovery": case in ("update-recovery", "update-cache-repair"),
        "in_progress": case == "update-running",
        "operation": {"phase": "preparing"},
        "candidate": {"version": "1.1", "release_id": 42, "changed": True},
        "recovery": "Review local metadata before updating.",
        "metadata_errors": [{"file": "candidate.json"}],
    }
    if case == "update-legacy-ready":
        update.pop("in_progress")
        update["operation"] = {"phase": "complete"}
    if case == "update-native":
        update["kind"] = "native"
    held = []
    hold_refresh = False
    page = browser.new_page(viewport={"width": width, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    if case == "late-poll":
        page.add_init_script(
            """(()=>{const t=setTimeout;window.setTimeout=(fn,ms,...args)=>t(fn,[5000,10000].includes(ms)?40:ms,...args)})();"""
        )

    def route(r):
        nonlocal state, hold_refresh
        path = r.request.url.split("link.test", 1)[-1]
        if path == "/account-link.js":
            return r.fulfill(content_type="text/javascript", body=SOURCE.read_text())
        if "kagnode-account" in path:
            if r.request.method == "GET":
                counts["get"] += 1
                if case == "initial-error":
                    return r.fulfill(
                        status=503,
                        json={"error": "Profile service temporarily unavailable."},
                    )
                if hold_refresh:
                    held.append(r)
                    return
                return r.fulfill(json=state)
            data = r.request.post_data_json
            action = data["action"]
            counts[action] = counts.get(action, 0) + 1
            if action.startswith("updates."):
                if action == "updates.check":
                    update.update(
                        needs_recovery=False,
                        metadata_errors=[],
                        can_apply=True,
                        operation={"phase": "complete"},
                    )
                return r.fulfill(json=update)
            if action == "policy":
                state.update(LINKED, admin=True)
            if action == "start":
                state = dict(PENDING)
            if action == "cancel":
                assert data.get("attempt_id") == "1:1"
                state = dict(BASE)
            if action == "poll" and case == "late-poll":
                held.append(r)
                return
            return r.fulfill(json=state)
        if path.startswith(("/api/status", "/api/session", "/manage/status")):
            return r.fulfill(json={"csrf": "fixture"})
        body = f'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body data-kn-account-app="{app}"><div id="dashboard" class="app-shell"><a href="/account">Account</a><input name="csrf" value="fixture"><meta name="csrf-token" content="fixture"><span data-kn-account-name>Local fixture</span><section data-kn-account-settings></section></div><script src="/account-link.js"></script>'
        r.fulfill(content_type="text/html", body=body)

    page.route("**/*", route)
    page.goto("https://link.test/", wait_until="domcontentloaded")
    page.wait_for_function("!!window.KagNodeAccounts")
    page.get_by_role("heading", name="KagNode Account", exact=True).wait_for()
    label = f"{engine}/{app}/{width}/{case}"
    if case == "resume":
        if "ABCDE-12345" not in page.locator("[data-kn-account-settings]").inner_text():
            failures.append(label + ": pending code omitted")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("!!window.KagNodeAccounts")
        page.get_by_role("heading", name="KagNode Account", exact=True).wait_for()
        if "ABCDE-12345" not in page.locator("[data-kn-account-settings]").inner_text():
            failures.append(label + ": reload lost pending flow")
        assert counts["start"] == 0
    elif case == "initial-error":
        if (
            page.get_by_role(
                "button", name="Retry account connection", exact=True
            ).count()
            != 1
        ):
            failures.append(label + ": initial failure has no retry")
    elif case == "late-poll":
        cancel = page.get_by_role("button", name="Cancel linking", exact=True)
        if not cancel.count():
            failures.append(label + ": no cancellation control")
        else:
            deadline = time.monotonic() + 3
            while not held and time.monotonic() < deadline:
                page.wait_for_timeout(30)
            assert held, label + ": no in-flight poll"
            cancel.click()
            page.get_by_role(
                "button", name="Link KagNode Account", exact=True
            ).wait_for()
            held.pop().fulfill(json=LINKED)
            page.wait_for_timeout(100)
            if "Linked as" in page.locator("[data-kn-account-settings]").inner_text():
                failures.append(label + ": late poll undid cancellation")
            assert counts["cancel"] == 1
    elif case == "late-refresh":
        hold_refresh = True
        page.evaluate("()=>{KagNodeAccounts.refresh()}")
        deadline = time.monotonic() + 3
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(20)
        assert held, label + ": refresh was not captured"
        page.get_by_role("button", name="Link KagNode Account", exact=True).click()
        page.wait_for_timeout(100)
        hold_refresh = False
        held.pop().fulfill(json=BASE)
        page.wait_for_timeout(100)
        if "ABCDE-12345" not in page.locator("[data-kn-account-settings]").inner_text():
            failures.append(label + ": late refresh erased new flow")
    elif case == "late-policy":
        hold_refresh = True
        page.evaluate("()=>{KagNodeAccounts.refresh()}")
        deadline = time.monotonic() + 3
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(20)
        assert held, label + ": refresh was not captured"
        page.get_by_role("button", name="Turn account sync on", exact=True).click()
        page.wait_for_timeout(100)
        hold_refresh = False
        held.pop().fulfill(json={**BASE, "enabled": False, "admin": True})
        page.wait_for_timeout(100)
        if not page.get_by_role(
            "button", name="Turn account sync off", exact=True
        ).count():
            failures.append(label + ": late refresh undid new policy")
    if case.startswith("update-"):
        panel = page.locator(".kn-update-panel")
        panel.get_by_text("1.1", exact=True).wait_for()
        review = panel.get_by_role("button", name="Review update", exact=True)
        if case in ("update-recovery", "update-cache-repair"):
            assert "Review local metadata" in panel.inner_text()
            assert "candidate.json" in panel.inner_text()
            assert review.count() == 0
            if case == "update-cache-repair":
                panel.get_by_role(
                    "button", name="Check for updates", exact=True
                ).click()
                review.wait_for()
                assert "Metadata needing review" not in panel.inner_text()
        elif case in ("update-ready", "update-legacy-ready"):
            review.click()
            page.get_by_role("dialog").wait_for()
            page.get_by_role("button", name="Cancel", exact=True).click()
            assert page.get_by_role("dialog").count() == 0
        else:
            assert review.count() == 0
            if case == "update-running":
                assert panel.get_by_role(
                    "button", name="Check for updates", exact=True
                ).is_disabled()
            elif case == "update-native":
                assert "verified native updater" in panel.inner_text()
            else:
                assert "Updates are not available" in panel.inner_text()
        assert counts.get("updates.apply", 0) == 0
    report.append(
        {
            "engine": engine,
            "app": app,
            "width": width,
            "case": case,
            "requests": counts.copy(),
        }
    )
    page.close()
    assert not errors, (label, errors)


with sync_playwright() as p:
    for engine in ENGINES:
        exe = os.environ.get("KAGNODE_BROWSER_EXECUTABLE")
        browser = getattr(p, engine).launch(
            headless=True, **({"executable_path": exe} if exe else {})
        )
        try:
            for app in APPS:
                for width in [390, 1440]:
                    cases = (
                        ["initial-error", "late-policy"]
                        if app == "cli"
                        else ["resume", "initial-error", "late-poll", "late-refresh"]
                    )
                    if app != "cli":
                        cases += [
                            "update-recovery",
                            "update-blocked",
                            "update-running",
                            "update-ready",
                            "update-cache-repair",
                            "update-native",
                            "update-legacy-ready",
                        ]
                    for case in cases:
                        run_case(browser, engine, app, width, case)
        finally:
            browser.close()
print(json.dumps({"failures": failures, "fixtures": len(report)}, indent=2))
assert not failures, "\n".join(failures)
