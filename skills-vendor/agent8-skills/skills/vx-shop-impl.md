---
name: vx-shop-impl
description: The implementation details related to VX or VX shop should unconditionally refer to this document. Additionally, you must read the `gameserver-sdk` skill together. VX is a platform money itself, and the VX shop is the shop provided within that platform. Each game only implements the interface, allowing items to be sold through the platform's vx shop and be applied to the game.
---

# VX Shop Implementation Guide

## What is VX and VX Shop?

**VX** is the primary currency of the Verse8 platform. Users purchase VX on Verse8 and use it to buy items or premium features in games created by creators.

**VX Shop** is a monetization system that enables creators to integrate revenue generation into their games:
- All payment processing handled by Verse8
- Creators only implement game logic
- 100 VX ≈ $1 USD
- Available only to CPP (Creator Partner Program) members

## Mandatory Prerequisites

**⚠️ CRITICAL: You MUST read the GameServer SDK documentation before starting VX Shop implementation.**

VX Shop requires server-side logic. All payment-related operations including purchase event handling and user state updates must be done on the server.

**Required Reading:**
- Full GameServer SDK documentation (skill: `gameserver-sdk`)
- Especially its "System Event Handlers" (`$onItemPurchased`), "Asset Management" (`$asset`), "Global State Management" (user state) and "remoteFunction" sections

# VX Shop Implementation Steps

## Step 0: Verify Product ID

**Pre-implementation Checklist:**

Check if the user's request includes a **Product ID**. The Product ID is the unique key used to identify products in VX Shop.

**If Product ID is Missing:**

Stop work and inform the user:

"To implement VX Shop, you must first register the product on the Verse8 platform.

1. Access Verse8 game management page
2. Navigate to VX Shop tab
3. Click 'Add New Item' button
4. Enter product information:
   - Product ID: Unique identifier for code (e.g., premium-subscription, gold-pack-1000)
   - Product Name: Display name shown to users
   - Price: VX price (100 VX ≈ $1)
   - Purchase Constraints: Set purchase limits (optional)

Once you've registered the product, provide me with the Product ID to begin implementation.

Detailed guide: /docs/vxshop/registering-products"

**If Product ID is Present:**
- Proceed to next step
- Product ID examples: `'premium-subscription'`, `'gold-pack-1000'`, `'gacha-10pull'`

## Step 1: UI Implementation

Design shop UI freely according to user's request. VX Shop does not impose UI restrictions.

**Common UI Patterns:**
- Dedicated shop screen
- In-game popup
- Inline purchase button
- Purchase option in inventory/settings screen

**Information to Include in UI:**
- Product name and description
- Price (VX)
- Purchase button
- Purchase status (already purchased, available to purchase)

## Step 2: VX Shop Integration

Use the `useVXShop` hook from `@verse8/platform` package to integrate with VX Shop.

### Basic Usage
```tsx
import { useVXShop } from '@verse8/platform';
import { useGlobalMyState } from '@agent8/gameserver';
import { useEffect } from 'react';

function Shop() {
  const { getItem, buyItem, refresh, onClose } = useVXShop();
  const myState = useGlobalMyState();

  // Refresh product list when VX Shop dialog closes
  useEffect(() => {
    const cancel = onClose(() => refresh());
    return cancel;
  }, [onClose, refresh]);

  const item = getItem('premium-subscription'); // Query product by Product ID

  return (
    <button onClick={() => buyItem('premium-subscription')}>
      Buy Premium - {item?.price} VX
    </button>
  );
}
```

### API Reference

**useVXShop() Returns:**
- `getItem(productId)` - Query specific product
- `buyItem(productId)` - Open purchase dialog (start payment)
- `refresh()` - Refresh product list
- `onClose(callback)` - Register callback when dialog closes

**VXShopItem Key Properties:**
- `productId` - Product ID
- `price` - VX price
- `purchasable` - Whether purchase is available
- `purchaseLimit` - Purchase limit
- `remainingPurchaseQuantity` - Remaining purchase count
- `purchaseLimitReached` - Whether limit is reached

### UI Handling by Purchase State
```tsx
const item = getItem('product-id');

// Unlimited purchases available
if (item?.purchasable && !item.purchaseLimit) {
  return <button onClick={() => buyItem(item.productId)}>{item.price} VX</button>;
}

// Limited purchases (show remaining count)
if (item?.purchasable && item.purchaseLimit && !item.purchaseLimitReached) {
  return (
    <button onClick={() => buyItem(item.productId)}>
      {item.price} VX ({item.remainingPurchaseQuantity}/{item.purchaseLimit})
    </button>
  );
}

// Limit reached
if (item?.purchaseLimitReached) {
  return <button disabled>Purchased</button>;
}

// Not purchasable
if (!item?.purchasable) {
  return <button disabled>{item?.purchaseBlockReason || 'Cannot Buy'}</button>;
}
```

## Step 3: Server Code Implementation

**IMPORTANT:** User state changes upon purchase completion MUST be handled on the server.

### Implement $onItemPurchased in the Server class

The handler is a method of the `Server` class — in `server/src/server.ts` for a structured project, or in the root `server.js` of a legacy one. The method below builds in either file; in `server/src/server.ts` give the parameter a type — `{ account, purchaseId, productId, quantity }: { account: string; purchaseId: number; productId: string; quantity: number; metadata?: Record<string, any> }` — plus `r: any` on each `ok` helper, and drop those annotations in a legacy `server.js`. A class has exactly ONE `$onItemPurchased`, so every product goes through its `switch`.

It is a webhook, not a player's call, and the platform may run it again:

- **Grant to the `account` argument.** It is the buyer. `$sender.account` is the buyer too, but a webhook `$sender` carries no auth data, so never gate a grant on them, and pass `account` explicitly to every `$global`/`$asset` call.
- **Guard with `purchaseId`.** The platform dedupes claims, but a handler that THREW is recorded FAILED and may be re-run from the top. On a legacy 1.x `server.js` failures come back as `{ error }` instead of throwing, which is why every call goes through `ok()`. Record each applied `purchaseId` last, and return early when it is already there. That makes a retry after a fully applied claim a no-op; it does not cover a throw after a grant already landed, so keep each product to a single grant where you can.
- **Currency and consumables go in `$asset`**, not in a read-modify-write of user state. Amounts are positive integers — multiply by `quantity`.
- **A `$lock` inside the handler needs `{ maxWaitMs: 1500 }`**: the webhook gives the handler 5s, the same as `$lock`'s default wait.

```javascript
// server/src/server.ts (server.js in a legacy project)
async $onItemPurchased({ account, purchaseId, productId, quantity }) {
  const ok = (r) => { if (r && typeof r.error === 'string' && Object.keys(r).length === 1) throw new Error(r.error); return r; }; // 1.x returns a failed call as exactly { error }; 2.x throws
  // Makes a retry after a FULLY applied claim a no-op. It does not cover a throw after a
  // grant landed (e.g. the marker write failing), so keep each case to a single grant.
  const { grantedPurchases = {} } = ok(await $global.getUserState(account, ['grantedPurchases']));
  if (grantedPurchases[purchaseId]) return { success: true };

  switch (productId) {
    case 'premium-subscription':
      // One-time purchase: set a permanent flag
      ok(await $global.updateUserState(account, {
        isPremium: true,
        premiumDate: Date.now(),
      }));
      break;

    case 'gold-pack-1000':
      // Consumable: currency lives in $asset
      ok(await $asset.mint('gold', 1000 * quantity, account));
      break;
  }

  // Written LAST, so it only marks a purchase whose grants all succeeded
  ok(await $global.updateUserState(account, {
    grantedPurchases: { ...grantedPurchases, [purchaseId]: true },
  }));
  return { success: true };
}
```

### Parameters
- `account`: Purchaser's account ID
- `purchaseId`: Unique transaction ID
- `productId`: Purchased product's Product ID
- `quantity`: Purchase quantity
- `metadata`: The object configured on the product, if any. If you read it, normalize it first: `const data = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;`

## Step 4: Real-time State Updates on Client

When server changes state, client automatically receives updates.

### Using useGlobalMyState and useAsset (Recommended)
```tsx
import { useGlobalMyState, useAsset } from '@agent8/gameserver';

function GameScreen() {
  const myState = useGlobalMyState(); // Auto-sync
  const { assets } = useAsset();      // Auto-sync, read-only

  const isPremium = myState?.isPremium || false;
  const gold = assets?.gold || 0;

  return (
    <div>
      {isPremium ? <div>Premium Member ✨</div> : <AdComponent />}
      <div>Gold: {gold}</div>
    </div>
  );
}
```

# Example Code

## Example 1: Premium Subscription

```tsx
// Client
import { useEffect } from 'react';
import { useVXShop } from '@verse8/platform';
import { useGlobalMyState } from '@agent8/gameserver';

function PremiumShop() {
  const { getItem, buyItem, refresh, onClose } = useVXShop();
  const myState = useGlobalMyState();

  useEffect(() => {
    const cancel = onClose(() => refresh());
    return cancel;
  }, [onClose, refresh]);

  const premiumItem = getItem('premium-subscription');
  const isPremium = myState?.isPremium || false;

  if (isPremium) {
    return <div>✨ Premium Member</div>;
  }

  return (
    <button onClick={() => buyItem('premium-subscription')}>
      Get Premium - {premiumItem?.price} VX
    </button>
  );
}
```

Server: the `'premium-subscription'` case of the single `$onItemPurchased` in Step 3, which sets `isPremium: true` for `account`.

## Example 2: Gacha System

```tsx
// Client
import { useEffect, useState } from 'react';
import { useVXShop } from '@verse8/platform';
import { useGameServer } from '@agent8/gameserver';

function GachaShop() {
  const { getItem, buyItem, refresh, onClose } = useVXShop();
  const { server } = useGameServer();
  const [pullResult, setPullResult] = useState(null);

  useEffect(() => {
    const cancel = onClose(async (payload) => {
      refresh();
      if (payload.purchased && payload.productId === 'gacha-10pull') {
        const result = await server.remoteFunction('openGachaBox', []);
        setPullResult(result);
      }
    });
    return cancel;
  }, [onClose, refresh, server]);

  return (
    <button onClick={() => buyItem('gacha-10pull')}>
      Buy 10-Pull
    </button>
  );
}
```

```javascript
// server/src/server.ts (server.js in a legacy project)
// Add this case to the $onItemPurchased switch in Step 3:
    case 'gacha-10pull':
      // Tickets are a consumable: keep them in $asset
      ok(await $asset.mint('gacha_ticket', 10 * quantity, account));
      break;

// ...and this regular method to the Server class, called by the client after the shop closes:
async openGachaBox() {
  const ok = (r) => { if (r && typeof r.error === 'string' && Object.keys(r).length === 1) throw new Error(r.error); return r; }; // 1.x returns a failed call as exactly { error }; 2.x throws
  // The lock stops two quick calls from both passing the ticket check
  return $lock('gacha:' + $sender.account, async () => {
    if (!ok(await $asset.has('gacha_ticket', 10))) throw new Error('Not enough tickets');
    ok(await $asset.burn('gacha_ticket', 10));

    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(rollWithProbability()); // returns an item id, e.g. 'hero_3'
    }
    // Grant the rolled items: one $asset balance per item id
    for (const itemId of results) {
      ok(await $asset.mint(itemId, 1));
    }
    return { items: results };
  });
}
```

# Critical Warnings

## ❌ Never Do This

1. Change state directly on client
2. Call buyItem without checking purchasable
3. Forget to call refresh()
4. Gate a grant on `$sender` auth fields (`isSubscriber`, `isFollower`, …) inside `$onItemPurchased`, or grant without the `purchaseId` guard

## ✅ Correct Approach

1. Change state only on server
2. Always check purchasable
3. Always call refresh()
4. Grant to the `account` argument, record each `purchaseId`, and keep currency and consumables in `$asset`
