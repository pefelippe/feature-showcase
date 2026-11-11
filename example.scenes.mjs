/**
 * A working showcase of the public TodoMVC demo. Run it with:
 *   node showcase.mjs record --scenes example.scenes.mjs --out /tmp/showcase-example --no-login
 */
export default {
  baseUrl: 'https://demo.playwright.dev',
  start: '/todomvc/',
  ready: async ({ page }) => {
    await page.getByPlaceholder('What needs to be done?').waitFor();
  },
  scenes: [
    {
      title: 'Add todos',
      narration: 'Type a task and press Enter, and it lands at the top of the list.',
      run: async ({ page, type }) => {
        const input = page.getByPlaceholder('What needs to be done?');
        await type(input, 'Record the demo');
        await input.press('Enter');
        await type(input, 'Share it with the team');
        await input.press('Enter');
      },
    },
    {
      title: 'Complete a todo',
      narration: "Tick a task when it's done, and the counter updates right away.",
      run: async ({ page, click, highlight }) => {
        await click(page.getByTestId('todo-item').first().getByRole('checkbox'));
        await highlight(page.getByTestId('todo-count'), 2000);
      },
    },
    {
      title: 'Filter',
      narration: 'The Active filter hides what you have already finished.',
      run: async ({ page, click, highlight }) => {
        await click(page.getByRole('link', { name: 'Active' }));
        await highlight(page.getByTestId('todo-item').first(), 2000);
      },
    },
  ],
};
