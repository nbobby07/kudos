import { chromium, expect, type Browser, type Page } from "@playwright/test";

export type CheckoutEvidence = {
  screenshot?: Buffer;
  network: { attempt: number; method: "POST"; path: "/checkout"; status: 402 }[];
  logs: { event: string; step: string }[];
};
export type CheckoutResult = {
  requirementId: "declined-payment-retry";
  evidence: CheckoutEvidence;
} & ({ state: "completed"; outcome: "passed" | "failed" } |
  { state: "error"; errorCode: "environment" | "tooling" | "timeout" | "interrupted" });

class RequirementFailure extends Error {}

/** Run inside the verification VM, using only the trusted fixture's loopback URL. */
export async function checkCheckout(options: {
  appUrl: string;
  assertionTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CheckoutResult> {
  const url = new URL(options.appUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Checkout requires a credential-free loopback app URL");
  }
  const timeout = options.assertionTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("Invalid assertion deadline");
  const evidence: CheckoutEvidence = { network: [], logs: [] };
  let browser: Browser | undefined;
  let page: Page | undefined;
  let step = "launch";
  let result: CheckoutResult;
  const log = (event: string) => {
    if (evidence.logs.length < 100) evidence.logs.push({ event, step });
  };
  const abort = () => { void browser?.close().catch(() => {}); };
  const assertRequirement = async (assertion: () => Promise<unknown>) => {
    try { await assertion(); }
    catch (error) {
      // Only assertion mismatches are product failures, not lost browser sessions.
      if (error instanceof Error && "matcherResult" in error) throw new RequirementFailure();
      throw error;
    }
  };
  try {
    options.signal?.throwIfAborted();
    options.signal?.addEventListener("abort", abort, { once: true });
    browser = await chromium.launch({ headless: true, timeout: 15_000 });
    options.signal?.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: "block" });
    page = await context.newPage();
    page.setDefaultTimeout(timeout);
    // Keep diagnostics useful without retaining arbitrary console text or tokens.
    page.on("console", (message) => log(`console-${message.type()}`));
    page.on("pageerror", () => log("page-error"));
    page.on("requestfailed", () => log("request-failed"));
    await page.route(`${url.origin}/checkout`, async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      await route.fulfill({ status: 402, contentType: "application/json", body: JSON.stringify({
        code: "PAYMENT_DECLINED", message: "Payment declined. Please try again.",
      }) });
      if (evidence.network.length < 100) evidence.network.push({
        attempt: evidence.network.length + 1, method: "POST", path: "/checkout", status: 402,
      });
    });
    step = "navigate";
    const response = await page.goto(url.origin, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (!response?.ok()) throw new Error("Fixture navigation failed");
    step = "submit";
    const submit = page.getByTestId("submit");
    await assertRequirement(() => expect(submit).toBeVisible({ timeout }));
    await assertRequirement(() => expect(submit).toBeEnabled({ timeout }));
    await submit.click();
    await assertRequirement(() => expect.poll(() => evidence.network.length, { timeout }).toBe(1));
    step = "declined-error";
    await assertRequirement(() => expect(page!.getByTestId("error")).toBeVisible({ timeout }));
    await assertRequirement(() => expect(page!.getByTestId("error")).toHaveText("Payment declined. Please try again.", { timeout }));
    step = "retry";
    const retry = page.getByTestId("retry");
    await assertRequirement(() => expect(retry).toBeVisible({ timeout }));
    await assertRequirement(() => expect(retry).toBeEnabled({ timeout }));
    await retry.click();
    await assertRequirement(() => expect.poll(() => evidence.network.length, { timeout }).toBe(2));
    await assertRequirement(() => expect(page!.getByTestId("error")).toBeVisible({ timeout }));
    await assertRequirement(() => expect(page!.getByTestId("error")).toHaveText("Payment declined. Please try again.", { timeout }));
    await assertRequirement(() => expect(retry).toBeEnabled({ timeout }));
    options.signal?.throwIfAborted();
    log("requirement-passed");
    result = { requirementId: "declined-payment-retry", state: "completed", outcome: "passed", evidence };
  } catch (error) {
    if (options.signal?.aborted) {
      log("check-interrupted");
      result = { requirementId: "declined-payment-retry", state: "error", errorCode: "interrupted", evidence };
    } else if (error instanceof RequirementFailure) {
      log("requirement-failed");
      result = { requirementId: "declined-payment-retry", state: "completed", outcome: "failed", evidence };
    } else {
      log("check-error");
      const errorCode = error instanceof Error && error.name === "TimeoutError" ? "timeout" :
        step === "navigate" ? "environment" : "tooling";
      result = { requirementId: "declined-payment-retry", state: "error", errorCode, evidence };
    }
    if (page && !page.isClosed()) {
      try { evidence.screenshot = await page.screenshot({ fullPage: true, timeout: 5000 }); }
      catch { log("screenshot-unavailable"); }
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    try { await browser?.close(); }
    catch { log("browser-cleanup-failed"); }
  }
  return result;
}
