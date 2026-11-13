// Order of814 (Shubham: "when you show the server screen, directly open it in the PC control and maximize the screen, or give an option to view
// in overlay"): the pure part of the two ways a show_screen card (F-214) opens a PC's screen. "Open in PC control" goes to that PC's PC control ›
// Screen, connects there and shows the screen maximized; "View here" is the layer above the overlay chat, as before. The card remembers which
// one he used last (that one is the bold button). Nothing connects before his tap: the tap leaves a one-shot request in memory (never in the
// address, so a link, a reload or a bookmark connects nothing), and PC control takes it only for that PC and only for a few seconds.

export type ScreenWay = 'pc-control' | 'here'
/** Where the card's choice is remembered (this browser). */
export const SCREEN_WAY_KEY = 'sad-screen-way'
/** The first time: PC control, the main way. */
export const parseScreenWay = (v: unknown): ScreenWay => (v === 'here' ? 'here' : 'pc-control')

/** That PC's PC control › Screen. */
export const pcControlScreenPath = (pc: string) => `/pc-control?pc=${encodeURIComponent(pc)}&view=screen`

/** The tap's request: which PC, and when. */
export interface ScreenAsk {
  pc: string
  at: number
}
/** How long PC control may take to come up and take the request (the page loads, then its list of PCs). */
export const SCREEN_ASK_MS = 15_000
/** The request is for this PC and recent enough to be the tap that brought PC control up. */
export const askIsFor = (ask: ScreenAsk | null, pc: string, now: number): boolean => ask !== null && ask.pc === pc && now - ask.at >= 0 && now - ask.at < SCREEN_ASK_MS
