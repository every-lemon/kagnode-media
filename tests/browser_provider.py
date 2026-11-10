"""Actual Media HTTP app, local fake issuer, no worker/transcoding."""

import argparse, base64, json, os, subprocess, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument("--engine", default=os.environ.get("KAGNODE_BROWSER_ENGINE", "chromium"))
args = p.parse_args()
source = ROOT
work = tempfile.TemporaryDirectory(prefix="media-core-fixture-")
core = Path(work.name)
env = {**os.environ, "KAGNODE_CORE_ROOT": str(core)}
process = subprocess.Popen(
    [str(source / "node_modules/.bin/tsx"), "tests/browser_provider_fixture.ts"],
    cwd=source,
    env=env,
    stdout=subprocess.PIPE,
    text=True,
)
state = json.loads(process.stdout.readline())
origin = state["origin"]


def control(action):
    request = urllib.request.Request(
        origin + "/__fixture/" + action, headers={"X-Fixture-Key": state["control"]}
    )
    urllib.request.urlopen(request, timeout=15).close()


output = Path(os.environ.get("KAGNODE_SCREENSHOT_DIR", ROOT / ".build/provider-login"))
output.mkdir(parents=True, exist_ok=True)
report = []
try:
    with sync_playwright() as pw:
        browser = getattr(pw, args.engine).launch(
            headless=True,
            **(
                {"executable_path": os.environ["KAGNODE_BROWSER_EXECUTABLE"]}
                if os.environ.get("KAGNODE_BROWSER_EXECUTABLE")
                else {}
            ),
        )
        for width in [390, 820, 1440]:
            context = browser.new_context(
                viewport={"width": width, "height": 950}, color_scheme="dark"
            )
            external = []
            errors = []
            context.route(
                "**/*",
                lambda route: route.continue_()
                if route.request.url.startswith(origin)
                else (external.append(route.request.url), route.abort()),
            )
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin + "/login")
            provider = page.locator("[data-core-login-provider]")
            expect(provider).to_be_enabled()
            expect(page.locator("[data-core-login]")).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
            box = page.locator(".kn-core-login-card").bounding_box()
            assert box and box["width"] >= min(width - 48, 400), box
            page.screenshot(path=str(output / f"{args.engine}-{width}-login.png"))
            form = page.locator('form[action="/login"]')
            form.locator("[name=email]").fill("local@example.test")
            form.locator("[name=password]").fill(state["password"])
            form.locator("button").click()
            page.wait_for_url(origin + "/")
            page.goto(origin + "/account")
            expect(page.locator(".page-heading h1")).to_be_visible()
            context.close()
            context = browser.new_context(
                viewport={"width": width, "height": 950}, color_scheme="dark"
            )
            context.route(
                "**/*",
                lambda route: route.continue_()
                if route.request.url.startswith(origin)
                else (external.append(route.request.url), route.abort()),
            )
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin + "/login")
            provider = page.locator("[data-core-login-provider]")
            if width == 390:
                control("pending")
                provider.click()
                expect(page.get_by_text("ABCDE-12345", exact=True)).to_be_visible(
                    timeout=15000
                )
                page.get_by_role("button", name="Cancel connection").click()
                expect(provider).to_be_enabled()
                control("offline")
                provider.click()
                expect(page.locator("[data-core-login-status]")).to_contain_text(
                    "Unable to connect", timeout=15000
                )
            control("approved")
            provider.click()
            page.wait_for_url(origin + "/account", timeout=20000)
            expect(page.locator(".page-heading h1")).to_be_visible()
            expect(
                page.get_by_role("heading", name="Fictional KagNode viewer", exact=True)
            ).to_be_visible()
            page.screenshot(path=str(output / f"{args.engine}-{width}-account.png"))
            assert not external, external
            assert not errors, errors
            context.close()
            report.append(
                {
                    "engine": args.engine,
                    "width": width,
                    "local_login": True,
                    "cancel": width == 390,
                    "issuer_failure": width == 390,
                    "provider_viewer_signup": width == 390,
                    "linked_provider": True,
                    "external_requests": 0,
                    "page_errors": 0,
                }
            )
        control("disabled")
        context = browser.new_context()
        page = context.new_page()
        page.goto(origin + "/login")
        expect(page.locator("[data-core-login-provider]")).to_have_count(0)
        context.close()
        browser.close()
    (output / f"{args.engine}-report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    print(json.dumps(report))
finally:
    process.terminate()
    process.wait(timeout=30)
    work.cleanup()
