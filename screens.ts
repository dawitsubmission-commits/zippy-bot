// ZIPPY screens: plain data only (no Telegram library), so the logic is easy to test.

export type Button = { text: string; data: string; url?: string };
export type Screen = { text: string; buttons: Button[][] };

export const TAGLINE = "One Tap. That's It.";

// Callback data is what Telegram sends back when a button is tapped.
// Telegram allows at most 64 bytes, so we only use short codes.
export const CB = {
  main: "m:main",
  cafe: "m:cafe",
  restaurant: "m:rest",
  package: "m:pkg",
  orders: "m:orders",
  wallet: "m:wallet",
  about: "m:about",
  contact: "m:contact",
  rider: "m:rider",
  adminHome: "a:home",
} as const;

const MAIN_MENU_BUTTON: Button = { text: "🏠 Main Menu", data: CB.main };

function simple(text: string): Screen {
  return { text, buttons: [[MAIN_MENU_BUTTON]] };
}

export function mainMenu(): Screen {
  return {
    text: `🏠 ZIPPY — ${TAGLINE}\n\nChoose an option below.`,
    buttons: [
      [{ text: "🍱 Cafeteria Delivery", data: CB.cafe }],
      [{ text: "🍔 Restaurant Delivery — Coming Soon", data: CB.restaurant }],
      [{ text: "📦 Package Delivery — Coming Soon", data: CB.package }],
      [{ text: "📋 My Orders", data: CB.orders }],
      [{ text: "💰 My Wallet", data: CB.wallet }],
      [{ text: "ℹ️ About ZIPPY", data: CB.about }],
      [{ text: "📞 Contact Us", data: CB.contact }],
      [{ text: "🚴 Apply for Delivery Job — Coming Soon", data: CB.rider }],
    ],
  };
}

// Admin sections (all are placeholders in Phase 1).
export const ADMIN_SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["dash", "📊 Dashboard"],
  ["orders", "📦 Manage Orders"],
  ["customers", "👥 All-Time Customers"],
  ["stats", "📈 Customer Statistics"],
  ["pay", "💳 Payment Verification"],
  ["wallet", "💰 Wallet Management"],
  ["cafes", "🍽️ Manage Cafeterias"],
  ["menu", "🍛 Manage Food Menu"],
  ["hours", "🕒 Opening Hours & Availability"],
  ["locations", "📍 Manage Delivery Locations"],
  ["announce", "📣 Send Announcement"],
  ["settings", "⚙️ Bot Settings"],
  ["reports", "📄 Reports & History"],
];

export function adminPanel(): Screen {
  return {
    text: "🔐 ZIPPY ADMIN PANEL",
    buttons: [
      ...ADMIN_SECTIONS.map(([key, label]) => [{ text: label, data: `a:${key}` }]),
      [MAIN_MENU_BUTTON],
    ],
  };
}

function adminStub(key: string): Screen {
  const section = ADMIN_SECTIONS.find(([k]) => k === key);
  if (!section) return adminPanel();
  return {
    text: `${section[1]}\n\nNot built yet. This section will be added in a later phase.`,
    buttons: [[{ text: "⬅ Admin Panel", data: CB.adminHome }]],
  };
}

export type RouteResult = { kind: "screen"; screen: Screen } | { kind: "denied" };

// Decides what a button tap shows. Admin buttons are checked HERE on the server side:
// hiding a button is never the security measure.
export function routeCallback(data: string, isAdminUser: boolean): RouteResult {
  if (data.startsWith("a:")) {
    if (!isAdminUser) return { kind: "denied" };
    if (data === CB.adminHome) return { kind: "screen", screen: adminPanel() };
    return { kind: "screen", screen: adminStub(data.slice(2)) };
  }
  switch (data) {
    case CB.restaurant:
      return { kind: "screen", screen: simple("🍔 Restaurant delivery is coming soon!\n\nStay tuned for updates.") };
    case CB.package:
      return { kind: "screen", screen: simple("📦 Package delivery is coming soon!\n\nStay tuned for updates.") };
    case CB.rider:
      return { kind: "screen", screen: simple("🚴 Rider applications are coming soon! Stay tuned for updates.") };
    case CB.orders:
      return { kind: "screen", screen: simple("📋 My Orders\n\nYou don't have any orders yet. Ordering isn't open yet.") };
    case CB.wallet:
      return { kind: "screen", screen: simple("💰 My Wallet\n\nThe wallet isn't available yet.") };
    case CB.about:
      return {
        kind: "screen",
        screen: simple(
          `ℹ️ About ZIPPY\n\nZIPPY is a student-focused delivery service starting around Hawassa University.\n\n"${TAGLINE}"\n\nCafeteria delivery will be our first service. Restaurant delivery, package delivery and rider applications are coming later.`,
        ),
      };
    case CB.contact:
      return {
        kind: "screen",
        screen: simple("📞 Contact Us\n\nContact details haven't been added yet."),
      };
    default:
      // Unknown or out-of-date button: safest is to show the main menu.
      return { kind: "screen", screen: mainMenu() };
  }
}
