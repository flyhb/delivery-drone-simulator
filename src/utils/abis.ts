// Minimal ABIs for simulator runtime
// The Hummingbird contract ABI.  In addition to the original
// `reportLiveness` function this simulator also interacts with
// delivery‑related functions exposed by the Hummingbird contract.  When
// polling for delivery requests the simulator calls
// `getOpenRequests` (if present) to retrieve a list of open and
// targeted delivery requests.  Each request is expected to contain an
// identifier, pickup/dropoff coordinates (×1e7), an optional target
// address and an expiry timestamp.  The simulator then proposes
// deliveries by calling `proposeDelivery`.  Once a delivery is
// accepted it progresses through `startDelivery`, `packagePicked`,
// `packageDropped` and `completeDelivery`.  See Device.ts for the
// implementation details.
export const HUMMINGBIRD_ABI = [
  // reportLiveness(int256 latitude, int256 longitude, int256 readyVal, uint256 timestamp)
  'function reportLiveness(int256,int256,int256,uint256)',
  // Returns an array of identifiers for all open delivery requests.  The
  // returned values correspond to request IDs.  Each ID can be
  // queried via `getRequest` to obtain full details.  This function
  // reflects the on‑chain signature `getOpenRequests() view returns
  // (uint256[])`.
  'function getOpenRequests() view returns (uint256[])',
  // Returns an array of identifiers for open delivery requests
  // targeted at the given device.  Targeted requests are not part
  // of the general open list until either accepted or expired.  This
  // corresponds to the on‑chain signature
  // `getOpenRequestsFor(address) view returns (uint256[])`.
  'function getOpenRequestsFor(address) view returns (uint256[])',
  // Returns the full DeliveryRequest struct for a given request ID.
  // Fields include the pickup and dropoff coordinates (×1e7),
  // targetedDevice, expiresAt and maxPrice among others.  This
  // reflects the on‑chain signature
  // `getRequest(uint256) view returns (tuple(uint256 id,address requester,int32 pickupLatE7,int32 pickupLonE7,int32 dropLatE7,int32 dropLonE7,uint256 price,uint256 proposedPrice,address drone,uint8 status,uint64 requestedAt,uint64 proposedAt,address targetedDevice,uint64 expiresAt,uint256 maxPrice,uint64 acceptedAt))`.
  'function getRequest(uint256) view returns (tuple(uint256 id,address requester,int32 pickupLatE7,int32 pickupLonE7,int32 dropLatE7,int32 dropLonE7,uint256 price,uint256 proposedPrice,address drone,uint8 status,uint64 requestedAt,uint64 proposedAt,address targetedDevice,uint64 expiresAt,uint256 maxPrice,uint64 acceptedAt))',
  // Submit a delivery proposal.  `requestId` identifies the delivery
  // request and `price` is specified in HB tokens with 18 decimals.
  'function proposeDelivery(uint256,uint256)',
  // Called by an accepted drone to indicate they are starting the delivery.
  'function startDelivery(uint256)',
  // Called once the package has been picked up.
  'function packagePicked(uint256)',
  // Called once the package has been dropped off.
  'function packageDropped(uint256)',
  // Called to mark the delivery as complete.
  'function completeDelivery(uint256)',
  // Emitted when a delivery proposal is accepted.  `id` is the
  // identifier of the delivery request and `drone` is the drone
  // address selected for the delivery.  The event also includes
  // the accepted price.
  'event DeliveryAccepted(uint256 indexed id,address indexed drone,uint256 price)'
];
