// The ONE place raw platform facts become plain business language for the
// Milestone 5G Admin Platform Status view. It converts a handful of known,
// safe booleans/names into labels — nothing more. It never reads
// `process.env`, never touches infrastructure identifiers, and is not a
// generic presentation framework.

export function environmentLabel(isProduction: boolean): string {
  return isProduction ? 'Production' : 'Development';
}

// Whether the local, Cognito-free stand-in auth boundary is active for this
// audience. The real boundary is Amazon Cognito.
export function authenticationModeLabel(isLocalDevelopment: boolean): string {
  return isLocalDevelopment
    ? 'Local development authentication'
    : 'Amazon Cognito';
}

// The payment integration posture. The development stand-in never moves
// real money; a real processor would report its own business name.
export function paymentProviderLabel(isDevelopmentStandIn: boolean): string {
  return isDevelopmentStandIn
    ? 'Development payment provider'
    : 'Live payment provider';
}
