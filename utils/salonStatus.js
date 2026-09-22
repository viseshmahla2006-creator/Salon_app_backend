// Is the salon's subscription currently active (paid AND not expired)?
function isSubscriptionActive(salon) {
  return !!(salon.subscriptionActive && salon.subscriptionExpiresAt && salon.subscriptionExpiresAt > new Date());
}

// If a temporary test-open window (via the MKCC code) has expired, auto-close the shop.
// Returns true if the salon document was changed (so the caller knows to save it).
function applyTempOpenExpiry(salon) {
  if (salon.tempOpenExpiresAt && salon.tempOpenExpiresAt < new Date() && salon.isOpen) {
    salon.isOpen = false;
    salon.tempOpenExpiresAt = undefined;
    return true;
  }
  return false;
}

module.exports = { isSubscriptionActive, applyTempOpenExpiry };
