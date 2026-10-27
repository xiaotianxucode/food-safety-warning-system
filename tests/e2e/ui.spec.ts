import { test, expect } from '@playwright/test';
test('多条预警横向滚动及暂停控制', async ({ page }) => {
  await page.route('**/api/alerts', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        items: Array.from({ length: 6 }, (_, i) => ({
          ...data.items[0],
          id: i + 1,
          payload: { ...data.items[0].payload, food: `测试食品${i + 1}` },
        })),
        cursor: 6,
      },
    });
  });
  await page.goto('/');
  await page.getByPlaceholder('请输入账号').fill('e2euser');
  await page.getByPlaceholder('请输入密码').fill('e2e-password-only');
  await page.getByRole('button', { name: '登录系统' }).click();
  await page.getByRole('button', { name: '下一组预警' }).click();
  await expect
    .poll(() => page.locator('.alert-grid').evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: '暂停滚动' }).click();
  await expect(page.getByRole('button', { name: '自动滚动', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('登录、查看分析、已读持久化、后台来源与移动端布局', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('请输入账号').fill('e2eadmin');
  await page.getByPlaceholder('请输入密码').fill('e2e-password-only');
  await page.getByRole('button', { name: '登录系统' }).click();
  await expect(page.getByRole('heading', { name: '食品安全预警' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('1 条新增预警');
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await page
    .getByRole('button')
    .filter({ has: page.getByRole('heading', { name: '日本 · 草莓' }) })
    .click();
  await expect(page.getByRole('dialog')).toContainText('涉事批次退运');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.getByRole('button', { name: '未读消息' }).click();
  await expect(page.getByRole('heading', { name: '暂时没有未读预警' })).toBeVisible();
  await page.getByRole('button', { name: '开发者后台' }).click();
  await page.getByRole('button', { name: '新闻数据库' }).click();
  await page.getByRole('button', { name: '查看详情' }).click();
  await expect(page.getByRole('dialog').getByRole('link')).toHaveAttribute('href', /foodmate.net/);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '账号管理', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'e2euser', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '预警动态', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: '食品安全预警' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});
