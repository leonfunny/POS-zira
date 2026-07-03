import { app } from 'electron';
import { join } from 'path';

export const APP_DISPLAY_NAME = 'Zira';
export const LEGACY_USER_DATA_NAME = 'Zira AI';
export const APP_USER_DATA_DIR = process.env.ELECTRON_USER_DATA_DIR
  || join(app.getPath('appData'), LEGACY_USER_DATA_NAME);

app.setPath('userData', APP_USER_DATA_DIR);
app.setName(APP_DISPLAY_NAME);
