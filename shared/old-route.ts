// Order o5007: the old-app reader's names, in one small file with no imports, so the menu, the router, the owner-only list
// (chat-scope.ts) and Alt+O can all read them without pulling anything else in. Rename the page here: OLD_ROUTE is its one address.

/** The page's address. ONE constant: rename the route here (the menu, the router, the owner-only list, the search bar and Alt+O all read it). */
export const OLD_ROUTE = '/old'
/** Its name in the menu, the search bar and the page's title. */
export const OLD_LABEL = 'Old app'
/** The socket on the agentic mount (/agent-api/agentic/old): the app token, the owner only. */
export const OLD_SOCKET = '/old'
/**
 * The shortcut that opens the page from anywhere. The others: Alt+J the Assistant's chat, Alt+K the fast bar, Alt+A the Assistant, Alt+M
 * maximize, Alt+B the CRM, Ctrl+B the search bar. No browser or Windows shortcut uses Alt+O.
 */
export const OLD_KEY = { code: 'KeyO', label: 'Alt+O' } as const
