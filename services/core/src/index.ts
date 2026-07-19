import { createApp } from './app';
import { getConfig } from '@sayre/config';

const portText = getConfig('CORE_PORT');
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('CORE_PORT must be an integer between 1 and 65535.');
}
createApp().listen(port, () => console.log(`[core] listening on :${port}`));
