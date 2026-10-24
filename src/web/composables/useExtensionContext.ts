import { useI18n } from "vue-i18n";
import { useDateText } from "@/composables/useDateText";
import { formatDate } from "@/utils/dates";
import type { ExtensionContext } from "@/utils/extension-display";
import { formatGeneralName } from "@/utils/x509";

/**
 * The UI-language texts of decoded extension values (ExtensionView, RevokedTable), bound to
 * vue-i18n and to the viewer's time zone. Data labels (OID names) stay as the server sends them,
 * except the access methods RFC 5280 defines, which the locales name.
 */
export function useExtensionContext(): ExtensionContext {
  const i18n = useI18n();
  const { t } = i18n;
  const dateText = useDateText();
  return {
    field: (key) => t(`extension.fields.${key}`),
    name: (name) => formatGeneralName(name, (type) => t(`extension.generalName.${type}`)),
    accessMethod: ({ oid, name }) => {
      const key = `extension.accessMethod.${name ?? ""}`;
      return name !== null && i18n.te(key) ? t(key) : (name ?? oid);
    },
    time: (iso) => formatDate(iso, dateText),
    yesNo: (value) => t(value ? "common.yes" : "common.no"),
  };
}
