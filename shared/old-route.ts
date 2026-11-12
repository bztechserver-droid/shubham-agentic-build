// Order o5007: the old-app reader's names, in one small file with no imports, so the menu, the router, the owner-only list
// (chat-scope.ts) and Alt+O can all read them without pulling anything else in. Rename the page here: OLD_ROUTE is its one address.

/** The page's address. ONE constant: rename the route here (the menu, the router, the owner-only list, the search bar and Alt+O all read it). Order o7236: it is /live now. */
export const OLD_ROUTE = '/live'
/** The address it had before (order o7236): a bookmark or a link to it still works, the router sends it on to OLD_ROUTE. */
export const OLD_LEGACY_ROUTE = '/old'
/** Its name in the menu, the search bar and the page's title (order o8d26: Shubham calls it "Live talking"; Alt+O keeps its name). */
export const OLD_LABEL = 'Live talking'
/** The one line under its name in the menu and the page picker (kept short: the picker cuts a long blurb). */
export const OLD_BLURB = 'Ask the old app, answers in seconds'
/** Order oe3cf: the second page, the old app's voice feature exactly (the classic page); /live is the efficient one. Same constants file, so the menu, the router and the owner-only list read one place. */
export const LIVE_CLASSIC_ROUTE = '/live-classic'
export const LIVE_CLASSIC_LABEL = 'Live talking classic'
export const LIVE_CLASSIC_BLURB = "The old app's voice talk, as it was"
/** The socket on the agentic mount (/agent-api/agentic/old): the app token, the owner only. */
export const OLD_SOCKET = '/old'
/**
 * The shortcut that opens the page from anywhere. The others: Alt+J the Assistant's chat, Alt+K the fast bar, Alt+A the Assistant, Alt+M
 * maximize, Alt+B the CRM, Ctrl+B the search bar. No browser or Windows shortcut uses Alt+O.
 */
export const OLD_KEY = { code: 'KeyO', label: 'Alt+O' } as const
