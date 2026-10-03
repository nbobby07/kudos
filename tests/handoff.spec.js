import { test, expect } from '@playwright/test';

test('older POST and SSE snapshots cannot overwrite newer workspace progress', async ({ page, request }) => {
  const initial = await (await request.get('/api/state')).json();
  initial.sequence += 1000;
  initial.daily.Aryan.tasks[0].completed = false;
  initial.daily.Aryan.tasks[0].title = 'Ordering regression task';
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() { window.workspaceEvents = this; }
    };
  });
  let entered, release;
  const pending = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  await page.route('**/api/task', async route => {
    entered();
    await delayed;
    await route.fulfill({ json: initial });
  });
  await page.goto('/tasks');
  await page.evaluate(snapshot => window.workspaceEvents.onmessage({ data: JSON.stringify(snapshot) }), initial);
  await page.getByRole('checkbox', { name: 'Ordering regression task' }).check();
  await pending;
  const newer = structuredClone(initial);
  newer.sequence++;
  newer.daily.Aryan.tasks[0].completed = true;
  await page.evaluate(snapshot => window.workspaceEvents.onmessage({ data: JSON.stringify(snapshot) }), newer);
  const response = page.waitForResponse('**/api/task');
  release();
  await response;
  await expect(page.getByRole('checkbox', { name: 'Ordering regression task' })).toBeChecked();
  await page.evaluate(snapshot => window.workspaceEvents.onmessage({ data: JSON.stringify(snapshot) }), initial);
  await expect(page.getByRole('checkbox', { name: 'Ordering regression task' })).toBeChecked();
});

test('Enter sends chat, Shift+Enter inserts a newline, and composition does not send', async ({ page }) => {
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Team chat', exact: true }).click();
  await page.locator('[data-chat-peer="Kiran"]').click();
  const input = page.getByLabel('Message to Kiran');
  await input.fill('First line');
  await input.press('Shift+Enter');
  await input.press('End');
  await input.pressSequentially('Second line');
  await expect(input).toHaveValue('First line\nSecond line');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(input).toHaveValue('First line\nSecond line');
  await expect(page.locator('.chat-message')).toHaveCount(0);
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('First line\nSecond line');
  await expect(input).toHaveValue('');
  await expect(page.locator('.chat-message')).toHaveCount(1);
  await input.press('Enter');
  await expect(page.locator('.chat-message')).toHaveCount(1);
});

test('shared blocked handoff, demo fix, and captured delivery', async ({ browser, page, request }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: "Hey Aryan, let's make progress." })).toBeVisible();
  await page.screenshot({ path: '/tmp/opencode/relay-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Verification', exact: true }).click();
  const noel = await browser.newPage();
  await noel.goto('/tasks');
  await noel.getByLabel('Demo teammate view').selectOption('Noel');
  await noel.getByRole('button', { name: 'Verification', exact: true }).click();
  await noel.getByRole('tab', { name: 'Verification', exact: true }).click();
  await page.getByRole('button', { name: 'Verify & Send to Noel' }).click();
  await expect(page.getByRole('button', { name: 'Verifying handoff...' })).toBeDisabled();
  await expect(noel.locator('.sidebar-bottom')).toContainText('Shared workspace live');
  await expect(page.getByText('Handoff blocked', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'Payment failure is not handled' })).toBeVisible();
  await expect(noel.getByText('Handoff blocked', { exact: true })).toBeVisible();
  await page.getByRole('switch').click();
  await page.getByRole('button', { name: 'Verify & Send to Noel' }).click();
  await expect(noel.getByText('All required checks passed · Demo', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(noel.getByText('demo-fix-002', { exact: true })).toBeVisible();
  const captured = await (await request.get('/api/state')).json();
  expect(captured.handoff.revision).toBe('demo-fix-002');
  expect(captured.handoff.results.every(result => result.outcome === 'Passed')).toBe(true);
  expect(errors).toEqual([]);
  await noel.close();
});

test('mobile layout and versioned contract editing', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: "Hey Aryan, let's make progress." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/opencode/relay-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Verification', exact: true }).click();
  await page.getByRole('tab', { name: 'API contract', exact: true }).click();
  await page.getByRole('button', { name: 'Edit requirements' }).click();
  await page.getByLabel('Deliverable', { exact: true }).fill('Checkout experience');
  await page.getByRole('button', { name: 'Save contract v2' }).click();
  await expect(page.getByText('Contract v2', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Checkout experience', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByText('/checkout', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('personal task completion unlocks delivery and updates teammates live', async ({ browser, page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/tasks');
  await expect(page.getByRole('button', { name: 'Send to Noel', exact: true })).toBeDisabled();
  const incomplete = await request.post('/api/send', { data: { from: 'Aryan', to: 'Noel', version: 1 } });
  expect(incomplete.status()).toBe(409);
  const other = await browser.newPage();
  await other.goto('/tasks');
  await expect(other.getByRole('heading', { name: 'My tasks for today' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Build the pending checkout state' }).check();
  await expect(other.getByRole('checkbox', { name: 'Build the pending checkout state' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Handle a declined payment' }).check();
  await page.getByRole('checkbox', { name: 'Polish the mobile checkout' }).check();
  await expect(page.locator('.task-list').getByText('Task by Noel', { exact: true })).toBeVisible();
  await expect(page.locator('.task-list').getByText('Task by Kiran', { exact: true })).toBeVisible();
  const noelCard = page.locator('.rail-card').filter({ has: page.getByRole('heading', { name: 'Noel', exact: true }) });
  await page.getByLabel("View Noel's details").hover();
  await expect(noelCard.getByText('RECOMMENDS FOR YOU', { exact: true })).toBeVisible();
  await expect(noelCard.getByText('THEIR TASK', { exact: true })).toBeVisible();
  await expect(noelCard.getByText('Build the checkout API around the frontend contract.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send to Noel', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Confirm the checkout request fields' }).check();
  await page.getByLabel("View Noel's details").hover();
  await expect(noelCard.getByText('Completed in your tasks', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Add stable selectors for checkout tests' }).check();
  await expect(page.getByRole('button', { name: 'Send to Noel', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Add Add an order confirmation state to my tasks' }).click();
  await expect(page.getByRole('button', { name: 'Send to Noel', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Add an order confirmation state' }).check();
  await page.getByRole('button', { name: 'Send to Noel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sent to Noel', exact: true })).toBeDisabled();
  await other.getByLabel('Demo teammate view').selectOption('Noel');
  await expect(other.getByRole('heading', { name: "Hey Noel, let's make progress." })).toBeVisible();
  const shared = await (await request.get('/api/state')).json();
  const delivery = shared.deliveries.find(item => item.from === 'Aryan' && item.to === 'Noel');
  expect(delivery.tasks.some(task => task.source === 'Noel')).toBe(true);
  expect(delivery.tasks.some(task => task.source === 'Kiran')).toBe(true);
  expect(delivery.tasks.some(task => task.title === 'Add an order confirmation state')).toBe(true);
  await page.getByRole('checkbox', { name: 'Polish the mobile checkout' }).uncheck();
  await expect(page.getByRole('button', { name: 'Send to Noel', exact: true })).toBeDisabled();
  expect(delivery.tasks.find(task => task.title === 'Polish the mobile checkout').completed).toBe(true);
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Build the pending checkout state' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Polish the mobile checkout' })).not.toBeChecked();
  await other.close();
});

test('Kudos landing opens the existing task dashboard on desktop and mobile', async ({ page }) => {
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const landingBackground = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    const landingButtonBackground = await page.getByRole('link', { name: 'Your tasks', exact: true }).evaluate(el => getComputedStyle(el).backgroundColor);
    expect(landingBackground).toBe('rgb(235, 229, 213)');
    expect(landingButtonBackground).toBe('rgb(104, 43, 53)');
    await expect(page).toHaveTitle('Kudos | Your teammates will love you.');
    await expect(page.getByRole('heading', { name: 'Kudos', exact: true })).toBeVisible();
    await page.locator('.kudos-intro').evaluate(el => el.getAnimations({ subtree: true }).forEach(animation => animation.finish()));
    await expect(page.getByText('Your teammates will love you.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/opencode/kudos-landing-${width}.png`, fullPage: true });
    await page.getByRole('link', { name: 'Your tasks', exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page).toHaveTitle('Kudos | Your Tasks');
    await expect(page.getByRole('heading', { name: 'My tasks for today' })).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(landingBackground);
    await expect(page.locator('.focus-banner')).toHaveCount(0);
    const tasks = await page.locator('.daily-tasks').boundingBox();
    const ai = await page.locator('.recommendations').boundingBox();
    if (width > 740) { expect(Math.abs(tasks.y - ai.y)).toBeLessThan(2); expect(ai.x).toBeGreaterThan(tasks.x + tasks.width); }
    else { expect(ai.y).toBeGreaterThan(tasks.y + tasks.height); }
    expect(await page.locator('.daily-progress > span').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(104, 43, 53)');
    expect(await page.locator('.brand-symbol').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(104, 43, 53)');
    await page.getByRole('button', { name: 'Verification', exact: true }).click();
    expect(await page.getByRole('button', { name: 'Verify & Send to Noel' }).evaluate(el => getComputedStyle(el).backgroundColor)).toBe(landingButtonBackground);
    await page.getByRole('button', { name: 'My day', exact: true }).click();
    await page.screenshot({ path: `/tmp/opencode/kudos-dashboard-${width}.png`, fullPage: true });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'My tasks for today' })).toBeVisible();
    await page.getByRole('link', { name: 'Kudos home' }).click();
    await expect(page.getByRole('heading', { name: 'Kudos', exact: true })).toBeVisible();
  }
});

test('landing story works on desktop and mobile without changing the workspace', async ({ page }) => {
  const errors = [];
  const writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByRole('link', { name: 'A good handoff, in four steps' }).click();
    await expect(page).toHaveURL(/#how-it-works$/);
    await expect(page.locator('.story-chapter')).toHaveCount(4);
    await page.getByRole('checkbox', { name: 'Handle declined payments', exact: true }).check();
    await expect(page.locator('.progress-copy')).toHaveText('2 of 3 tasks complete');
    await page.getByRole('button', { name: 'Add to my tasks' }).click();
    await expect(page.locator('.recommended-task')).toBeVisible();
    await expect(page.locator('.progress-copy')).toHaveText('2 of 4 tasks complete');
    await expect(page.getByRole('button', { name: "Added to Aryan's tasks" })).toBeDisabled();
    await page.getByRole('button', { name: 'Preview a handoff to Noel' }).click();
    await expect(page.locator('.incoming-item')).toHaveAttribute('open', '');
    await expect(page.locator('.incoming-item summary')).toBeFocused();
    await expect(page.locator('.incoming-detail')).toContainText('Declined-payment response documented');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width < 850) await expect(page.locator('.story-visual').first()).toHaveCSS('position', 'static');
    await page.screenshot({ path: `/tmp/opencode/kudos-story-${width}.png`, fullPage: true });
    await page.reload();
    await expect(page.locator('.recommended-task')).toBeHidden();
  }
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});

test('landing story keeps content readable with reduced motion and without JavaScript', async ({ page, browser }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto');
  await expect(page.locator('.story-visual').first()).toHaveCSS('position', 'static');
  await page.getByRole('button', { name: 'Preview a handoff to Noel' }).click();
  await expect(page.locator('.incoming-detail')).toBeVisible();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await context.newPage();
  await staticPage.goto(page.url());
  await expect(staticPage.locator('.story-chapter')).toHaveCount(4);
  await staticPage.locator('.incoming-item summary').click();
  await expect(staticPage.locator('.incoming-detail')).toBeVisible();
  await expect(staticPage.getByRole('link', { name: 'Open your workspace' })).toHaveAttribute('href', '/tasks');
  await context.close();
});

test('landing clap reveals Kudos and respects reduced motion', async ({ page }) => {
  await page.goto('/');
  const intro = page.locator('.kudos-intro');
  expect(await intro.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(5);
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await intro.evaluate(el => el.getAnimations({ subtree: true }).forEach(animation => {
      animation.pause();
      animation.currentTime = 1100;
    }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/opencode/kudos-clap-${width}.png`, fullPage: true });
  }
  await intro.evaluate(el => el.getAnimations({ subtree: true }).forEach(animation => animation.finish()));
  await expect(intro.locator('h1')).toHaveCSS('opacity', '1');
  await expect(page.locator('.clap-hand-left')).toHaveCSS('opacity', '0');
  await expect(page.locator('.clap-hand-right')).toHaveCSS('opacity', '0');
  await expect(page.locator('.kudos-sparkles')).toHaveCSS('opacity', '0');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Kudos', exact: true })).toBeVisible();
  await expect(page.locator('.clap-hand-left')).toBeHidden();
  await expect(page.locator('.kudos-sparkles')).toBeHidden();
  expect(await intro.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
});

test('bottom teammate profiles support hover, keyboard, and touch', async ({ page, browser, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/tasks');
  const noel = page.locator('[data-profile="Noel"]');
  await expect(noel.locator('.rail-card')).not.toBeVisible();
  const dock = await page.locator('.team-dock').boundingBox();
  const tasks = await page.locator('.daily-tasks').boundingBox();
  expect(dock.y).toBeGreaterThan(tasks.y + tasks.height);
  await noel.locator('summary').hover();
  await expect(noel.locator('.rail-card')).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(noel.locator('.rail-card')).not.toBeVisible();
  await noel.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(noel.locator('.rail-card')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(noel.locator('.rail-card')).not.toBeVisible();
  const mobile = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 375, height: 812 } });
  const touchPage = await mobile.newPage();
  await touchPage.goto('/tasks');
  await touchPage.getByLabel("View Kiran's details").tap();
  await expect(touchPage.locator('[data-profile="Kiran"] .rail-card')).toBeVisible();
  expect(await touchPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await touchPage.getByLabel("View Kiran's details").tap();
  await expect(touchPage.locator('[data-profile="Kiran"] .rail-card')).not.toBeVisible();
  await mobile.close();
});

test('teammate chat stays live and surfaces attributed recommendations', async ({ page, browser, request }) => {
  await request.post('/api/task-preferences', { data: { owner: 'Aryan', enabled: false } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/tasks');
  const noel = await browser.newPage();
  noel.on('pageerror', error => errors.push(error.message));
  await noel.goto('/tasks');
  await noel.getByLabel('Demo teammate view').selectOption('Noel');
  await noel.getByRole('button', { name: 'Team chat', exact: true }).click();
  await noel.locator('[data-chat-peer="Aryan"]').click();
  await noel.getByLabel('Message type').selectOption('recommendation');
  await noel.getByLabel('Task title', { exact: true }).fill('Add a payment timeout message');
  await noel.getByLabel('Message to Aryan').fill('If a payment takes too long, show a timeout message and allow retry.');
  await noel.getByRole('button', { name: 'Send recommendation', exact: true }).click();
  await expect(noel.getByRole('heading', { name: 'Add a payment timeout message', exact: true })).toBeVisible();
  const suggestion = page.locator('.suggestion').filter({ hasText: 'Add a payment timeout message' });
  await expect(suggestion.getByText('Recommended by Noel', { exact: true })).toBeVisible();
  await suggestion.getByRole('button', { name: 'Open chat', exact: true }).click();
  await expect(page.getByRole('log', { name: 'Conversation with Noel' })).toContainText('Add a payment timeout message');
  await page.getByLabel('Message to Noel').fill('My reply is still a draft.');
  await noel.getByLabel('Message type').selectOption('message');
  await noel.getByLabel('Message to Aryan').fill('Let me know if you need the response fixture.');
  await noel.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Let me know if you need the response fixture.');
  await expect(page.locator('[data-assistant-ui="thread"]')).toBeVisible();
  await expect(page.getByRole('log').locator('.chat-message')).toHaveCount(2);
  await expect(page.getByRole('log').locator('.message-meta strong')).toHaveText(['Noel', 'Noel']);
  await expect(page.getByLabel('Message to Noel')).toHaveValue('My reply is still a draft.');
  await expect(page.getByLabel('Message to Noel')).toBeFocused();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(noel.getByRole('log')).toContainText('My reply is still a draft.');
  await page.screenshot({ path: '/tmp/opencode/kudos-chat-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'My day', exact: true }).click();
  await expect(page.locator('.suggestion-list')).not.toContainText('Let me know if you need the response fixture.');
  await page.getByRole('button', { name: 'Add Add a payment timeout message to my tasks', exact: true }).click();
  const task = page.locator('.daily-task').filter({ hasText: 'Add a payment timeout message' });
  await expect(task.getByText('Task by Noel', { exact: true })).toBeVisible();
  await page.reload();
  await expect(task.getByText('Task by Noel', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Team chat', exact: true }).click();
  await page.locator('[data-chat-peer="Noel"]').click();
  await expect(page.getByRole('log')).toContainText('Add a payment timeout message');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/opencode/kudos-chat-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Back to all messages' }).click();
  await page.locator('[data-chat-peer="Kiran"]').click();
  await expect(page.getByRole('log')).not.toContainText('Add a payment timeout message');
  const invalid = await request.post('/api/chat', { data: { from: 'Noel', to: 'Noel', kind: 'message', text: 'Cannot send to myself' } });
  expect(invalid.status()).toBe(400);
  expect(errors).toEqual([]);
  await noel.close();
  await request.post('/api/task-preferences', { data: { owner: 'Aryan', enabled: true } });
});

test('DM inbox, group replies, and attributed manual and automatic to-do additions', async ({ page, browser, request }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'Team chat', exact: true }).click();
  await expect(page.locator('.chat-contact')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Open Kiran + Noel conversation' })).toBeVisible();
  await expect(page.locator('.inbox-welcome')).toBeVisible();
  await page.getByLabel('Auto-add task ideas').uncheck();
  const noel = await browser.newPage();
  await noel.goto('/tasks');
  await noel.getByLabel('Demo teammate view').selectOption('Noel');
  await noel.getByRole('button', { name: 'Team chat', exact: true }).click();
  await noel.locator('[data-chat-peer="group"]').click();
  await noel.getByLabel('Message type').selectOption('recommendation');
  await noel.getByLabel('Task title', { exact: true }).fill('Review the checkout error copy together');
  await noel.getByLabel('Message to Kiran + Noel').fill('Aryan and Kiran, please review the payment error copy before integration.');
  await noel.getByRole('button', { name: 'Send recommendation', exact: true }).click();
  await expect(page.locator('[data-chat-peer="group"] .unread-count')).toBeVisible();
  await page.screenshot({ path: '/tmp/opencode/kudos-inbox-desktop.png', fullPage: true });
  await page.locator('[data-chat-peer="group"]').click();
  const idea = page.locator('.chat-message').filter({ hasText: 'Review the checkout error copy together' });
  await expect(idea.getByText('Recommended by Noel', { exact: true })).toBeVisible();
  await expect.poll(() => idea.evaluate(element => {
    const bubble = element.querySelector('.message-bubble')?.getBoundingClientRect();
    const action = element.querySelector('.message-task-actions')?.getBoundingClientRect();
    return Boolean(bubble && action && action.top >= bubble.bottom);
  })).toBe(true);
  await idea.getByRole('button', { name: '+ Add to your to-do list', exact: true }).click();
  await expect(idea.getByText('Added to your to-do list', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose a date', exact: true })).toHaveCount(0);
  await page.getByLabel('Message to Kiran + Noel').fill('I added it to my to-do list.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(noel.getByRole('log')).toContainText('I added it to my to-do list.');
  await page.getByLabel('Auto-add task ideas').check();
  await noel.getByLabel('Task title', { exact: true }).fill('Add a checkout timeout fixture');
  await noel.getByLabel('Message to Kiran + Noel').fill('A task idea that can be caught automatically if Aryan misses it.');
  await noel.getByRole('button', { name: 'Send recommendation', exact: true }).click();
  const autoIdea = page.locator('.chat-message').filter({ hasText: 'Add a checkout timeout fixture' });
  await expect(autoIdea.getByText('Automatically added to your to-do list', { exact: true })).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: '/tmp/opencode/kudos-group-desktop.png', fullPage: true });
  await autoIdea.getByRole('button', { name: 'View task', exact: true }).click();
  const manualEntry = page.locator('.daily-task').filter({ hasText: 'Review the checkout error copy together' });
  await expect(manualEntry).toContainText('Task by Noel');
  const autoEntry = page.locator('.daily-task').filter({ hasText: 'Add a checkout timeout fixture' });
  await expect(autoEntry).toContainText('Task by Noel');
  await page.reload();
  await expect(autoEntry).toHaveCount(1);
  await page.getByRole('button', { name: 'Team chat', exact: true }).click();
  await page.locator('[data-chat-peer="group"]').click();
  await autoIdea.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'My day', exact: true }).click();
  await expect(autoEntry).toHaveCount(0);
  await page.waitForTimeout(2200);
  await expect(autoEntry).toHaveCount(0);
  const current = await (await request.get('/api/state')).json();
  const message = current.messages.find(m => m.title === 'Review the checkout error copy together');
  const retry = await request.post('/api/add-task', { data: { from: 'Aryan', id: `chat-${message.id}` } });
  expect(retry.status()).toBe(200);
  const updated = await retry.json();
  expect(updated.daily.Aryan.tasks.filter(entry => entry.messageId === message.id)).toHaveLength(1);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Team chat', exact: true }).click();
  await expect(page.locator('.chat-contact')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/opencode/kudos-inbox-mobile.png', fullPage: true });
  await page.locator('[data-chat-peer="group"]').click();
  await expect(page.getByRole('log')).toContainText('I added it to my to-do list.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const invalid = await request.post('/api/remove-task', { data: { from: 'Aryan', id: 'not-a-task' } });
  expect(invalid.status()).toBe(404);
  expect(errors).toEqual([]);
  await noel.close();
});

test('incoming messages show bottom-right notifications without historical or duplicate alerts', async ({ page, browser, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'My tasks for today' })).toBeVisible();
  await expect(page.locator('.message-notification')).toHaveCount(0);
  const sender = await browser.newPage();
  await sender.goto('/tasks');
  await sender.getByLabel('Demo teammate view').selectOption('Noel');
  await sender.getByRole('button', { name: 'Team chat', exact: true }).click();
  await sender.locator('[data-chat-peer="Aryan"]').click();
  await sender.getByLabel('Message to Aryan').fill('Can you check the latest checkout response?');
  await sender.getByLabel('Message to Aryan').press('Enter');
  const notification = page.locator('.message-notification');
  await expect(notification).toHaveCount(1);
  await expect(notification).toContainText('Noel messaged you');
  await expect(notification).toContainText('Can you check the latest checkout response?');
  const position = await notification.boundingBox();
  expect(position.x).toBeGreaterThan(1000);
  expect(position.y + position.height).toBeLessThanOrEqual(1000);
  await request.post('/api/task-preferences', { data: { owner: 'Kiran', enabled: false } });
  await expect(notification).toHaveCount(1);
  await page.screenshot({ path: '/tmp/opencode/kudos-message-notification.png', fullPage: true });
  await notification.getByRole('button', { name: 'View message', exact: true }).click();
  await expect(page.getByRole('log', { name: 'Conversation with Noel' })).toContainText('Can you check the latest checkout response?');
  await expect(notification).toHaveCount(0);
  await page.bringToFront();
  await request.post('/api/chat', { data: { from: 'Noel', to: 'Aryan', kind: 'message', text: 'This conversation is already open.' } });
  await expect(page.getByRole('log')).toContainText('This conversation is already open.');
  await expect(notification).toHaveCount(0);
  await request.post('/api/chat', { data: { from: 'Aryan', to: 'Kiran', kind: 'message', text: 'My own message is not a notification.' } });
  await expect(notification).toHaveCount(0);
  await page.getByRole('button', { name: 'My day', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await request.post('/api/chat', { data: { from: 'Kiran', to: 'Aryan', kind: 'message', text: 'Mobile checkout is ready to test.' } });
  await expect(notification).toHaveCount(1);
  await expect(notification).toContainText('Kiran messaged you');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await notification.getByRole('button', { name: 'Dismiss message notification' }).click();
  await expect(notification).toHaveCount(0);
  await request.post('/api/chat', { data: { from: 'Noel', to: 'group', kind: 'message', text: 'A quick group update for everyone.' } });
  await expect(notification).toContainText('Noel messaged the group');
  await notification.getByRole('button', { name: 'View message', exact: true }).click();
  await expect(page.getByRole('log', { name: 'Conversation with Kiran + Noel' })).toContainText('A quick group update for everyone.');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My tasks for today' })).toBeVisible();
  await expect(notification).toHaveCount(0);
  await sender.close();
});

test('four-item sidebar and October demo calendar show dates, times, and mobile agenda', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'My tasks for today' })).toBeVisible();
  expect(await page.locator('.sidebar nav button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['My day', 'Team chat', 'Calendar', 'Verification']);
  await expect(page.getByRole('button', { name: 'Shared contract', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Incoming', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'October 2026', exact: true })).toBeVisible();
  await expect(page.locator('.month-grid [data-calendar-day]')).toHaveCount(31);
  expect(await page.locator('.month-grid > *').nth(3).getAttribute('data-calendar-day')).toBe('1');
  await expect(page.locator('[aria-current="date"]')).toHaveAttribute('data-calendar-day', '3');
  await expect(page.locator('.month-agenda')).toContainText('09:30');
  await expect(page.locator('.month-agenda')).toContainText('14:00');
  await page.getByRole('button', { name: /^October 9, 2026/ }).click();
  await expect(page.locator('.month-agenda')).toContainText('October 9');
  await expect(page.locator('.month-agenda')).toContainText('10:00');
  await expect(page.locator('.month-agenda')).toContainText('15:30');
  await expect(page.locator('.month-demo-note')).toContainText('not real deadlines');
  await page.screenshot({ path: '/tmp/opencode/kudos-october-desktop.png', fullPage: true });
  await page.getByRole('button', { name: /^October 4, 2026/ }).click();
  await expect(page.getByText('No deadlines on this day.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Today · Oct 3', exact: true }).click();
  await expect(page.locator('.month-agenda')).toContainText('October 3');
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: /^October 9, 2026/ }).click();
  await expect(page.locator('.month-agenda')).toContainText('10:00');
  await page.screenshot({ path: '/tmp/opencode/kudos-october-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Back to my tasks', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My tasks for today' })).toBeVisible();
});

test('custom tasks save, synchronize, and reject empty titles', async ({ page, browser, request }) => {
  await page.goto('/tasks');
  const other = await browser.newPage();
  await other.goto('/tasks');
  await expect(other.getByRole('heading', { name: 'My tasks for today' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a new task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Task title', { exact: true }).fill('Review the checkout handoff notes');
  await dialog.getByLabel('Details (optional)', { exact: true }).fill('Write a short summary of the frontend changes.');
  await dialog.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Review the checkout handoff notes' })).not.toBeChecked();
  await expect(other.getByRole('checkbox', { name: 'Review the checkout handoff notes' })).toBeVisible();
  await expect(page.locator('.daily-task').filter({ hasText: 'Review the checkout handoff notes' })).toContainText('Write a short summary of the frontend changes.');
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Review the checkout handoff notes' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Review the checkout handoff notes' }).check();
  await expect(other.getByRole('checkbox', { name: 'Review the checkout handoff notes' })).toBeChecked();
  const invalid = await request.post('/api/create-task', { data: { from: 'Aryan', title: '   ', description: '' } });
  expect(invalid.status()).toBe(400);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Add a new task', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Close new task dialog', exact: true }).click();
  await other.close();
});

test('task deadlines appear in calendar with consistent teammate colors', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'My tasks for today' })).toBeVisible();
  const colors = { Aryan: 'rgb(166, 56, 70)', Noel: 'rgb(35, 112, 78)', Kiran: 'rgb(40, 95, 170)' };
  for (const [name, color] of Object.entries(colors)) {
    expect(await page.locator(`.avatar.${name.toLowerCase()}`).first().evaluate(el => getComputedStyle(el).color)).toBe(color);
    expect(await page.locator(`.daily-task[data-author="${name}"] .task-checkbox`).first().evaluate(el => getComputedStyle(el).borderColor)).toBe(color);
  }
  await page.getByRole('button', { name: 'Add a new task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Task title', { exact: true }).fill('Finalize the October handoff');
  await dialog.getByLabel('Due date', { exact: true }).fill('2026-10-09');
  await dialog.getByLabel('Due time', { exact: true }).fill('14:45');
  await dialog.getByRole('button', { name: 'Add task', exact: true }).click();
  const task = page.locator('.daily-task').filter({ hasText: 'Finalize the October handoff' });
  await expect(task).toHaveAttribute('data-author', 'Aryan');
  await expect(task).toContainText('14:45');
  await expect(task).toContainText('Added by Aryan');
  await page.reload();
  await expect(task).toContainText('14:45');
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.getByRole('button', { name: /^October 9, 2026/ }).click();
  const agenda = page.locator('.agenda-task').filter({ hasText: 'Finalize the October handoff' });
  await expect(agenda).toHaveCount(1);
  await expect(agenda).toContainText('14:45');
  await expect(agenda).toContainText('Your due date · Local time');
  await expect(agenda.locator('.example-deadline')).toHaveCount(0);
  expect(await agenda.locator('time').evaluate(el => getComputedStyle(el).color)).toBe(colors.Aryan);
  for (const [name, color] of Object.entries(colors)) {
    expect(await page.locator(`.author-legend [data-author="${name}"] i`).evaluate(el => getComputedStyle(el).backgroundColor)).toBe(color);
  }
  await page.screenshot({ path: '/tmp/opencode/kudos-due-dates-colors.png', fullPage: true });
  await page.getByRole('button', { name: 'My day', exact: true }).click();
  await page.getByRole('button', { name: 'Add a new task', exact: true }).click();
  await dialog.getByLabel('Task title', { exact: true }).fill('Prepare the November launch');
  await dialog.getByLabel('Due date', { exact: true }).fill('2026-11-06');
  await dialog.getByLabel('Due time', { exact: true }).fill('08:15');
  await dialog.getByRole('button', { name: 'Add task', exact: true }).click();
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'November 2026', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^November 6, 2026/ }).click();
  await expect(page.locator('.month-agenda')).toContainText('Prepare the November launch');
  await expect(page.locator('.month-agenda')).toContainText('08:15');
  await page.getByRole('button', { name: 'Today · Oct 3', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'October 2026', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const deadline of [{ dueDate: '2026-02-30', dueTime: '12:00' }, { dueDate: '2026-10-09', dueTime: '24:00' }, { dueDate: '2026-10-09', dueTime: '' }]) {
    const response = await request.post('/api/create-task', { data: { from: 'Aryan', title: 'Invalid deadline', description: '', ...deadline } });
    expect(response.status()).toBe(400);
  }
  const shared = await (await request.get('/api/state')).json();
  const saved = shared.daily.Aryan.tasks.find(item => item.title === 'Finalize the October handoff');
  expect(saved.dueDate).toBe('2026-10-09');
  expect(saved.dueTime).toBe('14:45');
  expect(saved.createdBy).toBe('Aryan');
});

test('delete controls remove tasks live without toggling completion', async ({ page, browser, request }) => {
  await page.goto('/tasks');
  const other = await browser.newPage();
  await other.goto('/tasks');
  const created = await request.post('/api/create-task', { data: { from: 'Aryan', title: 'Remove this task', description: 'A temporary task.' } });
  const before = await created.json();
  const temporary = before.daily.Aryan.tasks.find(task => task.title === 'Remove this task');
  const remove = page.getByRole('button', { name: 'Delete Remove this task', exact: true });
  await expect(remove).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  const row = page.locator('.daily-task').filter({ has: remove });
  const labelBox = await row.locator('.task-toggle').boundingBox();
  const buttonBox = await remove.boundingBox();
  expect(buttonBox.x).toBeGreaterThanOrEqual(labelBox.x + labelBox.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await remove.click();
  await expect(page.getByRole('checkbox', { name: 'Remove this task', exact: true })).toHaveCount(0);
  await expect(other.getByRole('checkbox', { name: 'Remove this task', exact: true })).toHaveCount(0);
  const after = await (await request.get('/api/state')).json();
  expect(after.daily.Aryan.version).toBe(before.daily.Aryan.version + 1);
  expect(after.daily.Aryan.tasks).toEqual(before.daily.Aryan.tasks.filter(task => task.id !== temporary.id));
  expect(after.deliveries).toEqual(before.deliveries);
  const invalid = await request.post('/api/remove-task', { data: { from: 'Noel', id: before.daily.Aryan.tasks[0].id } });
  expect(invalid.status()).toBe(404);
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Remove this task', exact: true })).toHaveCount(0);
  await other.close();

  await page.getByLabel('Demo teammate view').selectOption('Kiran');
  const kiran = (await (await request.get('/api/state')).json()).daily.Kiran;
  for (const task of kiran.tasks) {
    await page.getByRole('button', { name: `Delete ${task.title}`, exact: true }).click();
    await expect(page.locator(`[data-task="${task.id}"]`)).toHaveCount(0);
  }
  await expect(page.locator('.tasks-empty')).toBeVisible();
  await expect(page.locator('.daily-progress > span')).toHaveCSS('width', '0px');
  await expect(page.getByRole('button', { name: 'Send to Noel', exact: true })).toBeDisabled();
  const empty = await (await request.get('/api/state')).json();
  const send = await request.post('/api/send', { data: { from: 'Kiran', to: 'Noel', version: empty.daily.Kiran.version } });
  expect(send.status()).toBe(409);
});

test('deleted teammate tasks stay removed after a server restart', async ({ playwright }) => {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { once } = await import('node:events');
  const dir = await mkdtemp('/tmp/opencode/kudos-delete-');
  let child, api;
  async function start() {
    child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, VERIFICATION_MODE: 'simulation' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out.')), 10000);
      let output = '';
      child.stdout.on('data', data => {
        output += data;
        const match = output.match(/Relay listening on port (\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited before startup.')); });
    });
    api = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${port}` });
  }
  async function stop() {
    await api?.dispose(); api = null;
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  }
  try {
    await start();
    const response = await api.post('/api/remove-task', { data: { from: 'Aryan', id: 'teammate-noel' } });
    expect(response.status()).toBe(200);
    const saved = await response.json();
    expect(saved.deletedSeedTasks).toContain('Aryan:teammate-noel');
    await stop();
    await start();
    const loaded = await (await api.get('/api/state')).json();
    expect(loaded.daily.Aryan.tasks.some(task => task.id === 'teammate-noel')).toBe(false);
    expect(loaded.daily.Aryan.version).toBe(saved.daily.Aryan.version);
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
