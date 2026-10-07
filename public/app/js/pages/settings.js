// The Settings page (/app/settings.html).

import { initBackground } from "../settings/background.js";
import { initEmail } from "../settings/email.js";
import { initInvites } from "../settings/invites.js";
import { initKeyCheck } from "../settings/keycheck.js";
import { initKeys } from "../settings/keys.js";
import { initMugBonus } from "../settings/mugbonus.js";
import { initPrefs } from "../settings/prefs.js";
import { initWages } from "../settings/wages.js";
import { watchForUpdates } from "/js/core/update.js";

initKeys();
initKeyCheck();
initPrefs();
initMugBonus();
initWages();
initEmail();
initBackground();
initInvites();

watchForUpdates();
