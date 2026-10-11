const MESSAGES = new Map([
  ["OAuthCallbackError", "La connexion a été refusée ou annulée par le service de connexion."],
  ["AccessDenied", "Ce compte n’a pas accès au portail."],
  ["Configuration", "Le portail a un problème de configuration avec le service de connexion."],
]);

const GENERIC = "La connexion a échoué.";

export function authErrorMessage(code: string | null): string {
  return (code && MESSAGES.get(code)) || GENERIC;
}
