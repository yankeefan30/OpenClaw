import { validateMeetingHandoffGrant } from "./policy.mjs";
import {
  defaultMeetingGrantPath,
  readPrivateJson,
  writePrivateJson,
} from "./private-store.mjs";

export { defaultMeetingGrantPath } from "./private-store.mjs";

export function readMeetingHandoffGrant(filePath = defaultMeetingGrantPath()) {
  return validateMeetingHandoffGrant(readPrivateJson(filePath));
}

export function installMeetingHandoffGrant(value, {
  filePath = defaultMeetingGrantPath(),
  replace = false,
} = {}) {
  const grant = validateMeetingHandoffGrant(value);
  return writePrivateJson(filePath, grant, { replace, backup: replace });
}
