/**
 * Armazenamento de segredos: no iPhone, o chaveiro (SecureStore).
 *
 * `secure.web.ts` é a versão do navegador, usada só na prévia web de
 * desenvolvimento — o Metro escolhe o arquivo pela plataforma.
 */
import * as SecureStore from "expo-secure-store";

export const secureGet = (key: string) => SecureStore.getItemAsync(key);
export const secureSet = (key: string, value: string) => SecureStore.setItemAsync(key, value);
export const secureDelete = (key: string) => SecureStore.deleteItemAsync(key);
