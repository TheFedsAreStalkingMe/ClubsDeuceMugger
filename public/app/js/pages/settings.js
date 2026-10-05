// The Settings page (/app/settings.html).

import { initEmail } from "../settings/email.js";
import { initInvites } from "../settings/invites.js";
import { initKeys } from "../settings/keys.js";
import { initPrefs } from "../settings/prefs.js";
import { initWages } from "../settings/wages.js";
import { watchForUpdates } from "/js/core/update.js";

initKeys();
initPrefs();
initWages();
initEmail();
initInvites();

watchForUpdates();
