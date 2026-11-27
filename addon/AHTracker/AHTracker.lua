-- AH Tracker: keeps each Auctionator scan, with its time, in AHTRACKER_DB.
-- WoW writes AHTRACKER_DB to WTF\Account\<account>\SavedVariables\AHTracker.lua on /reload or logout,
-- where the AH Tracker app imports it. This addon only reads scan results; it never touches the AH.

local MAX_SCANS = 12      -- older scans are dropped; the app imports on every /reload, so 12 is plenty

local function Print(msg)
  DEFAULT_CHAT_FRAME:AddMessage("|cff33bbffAH Tracker:|r " .. msg)
end

-- Format 1 (full scan, every listing): "itemId,count,buyout,minBid" per listing, buyout for the whole
-- stack (0 = bid only). Both Auctionator full-scan paths pass GetAuctionItemInfo / GetReplicateItemInfo
-- results: [3] = count, [8] = min bid, [10] = buyout, [17] = item id.
local function EncodeListings(rawScan)
  local parts, n = {}, 0
  for _, entry in ipairs(rawScan) do
    local info = entry.auctionInfo or entry.replicateInfo
    if info then
      local count, minBid, buyout, itemId = info[3], info[8], info[10], info[17]
      if itemId and itemId > 0 and count and count > 0 then
        n = n + 1
        parts[n] = itemId .. "," .. count .. "," .. (buyout or 0) .. "," .. (minBid or 0)
      end
    end
  end
  return table.concat(parts, ";"), n
end

-- Format 2 (browse scan, one summary per item): "itemId,totalQuantity,minPrice" from
-- C_AuctionHouse browse results, where minPrice is the cheapest unit buyout.
local function EncodeSummaries(rawScan)
  local parts, n = {}, 0
  for _, r in ipairs(rawScan) do
    local itemId = r.itemKey and r.itemKey.itemID
    if itemId and itemId > 0 and r.totalQuantity and r.totalQuantity > 0 then
      n = n + 1
      parts[n] = itemId .. "," .. r.totalQuantity .. "," .. (r.minPrice or 0)
    end
  end
  return table.concat(parts, ";"), n
end

-- Which auction house is open: the goblin towns share the neutral (Blackwater) house, every other
-- auctioneer is the player's faction house. Set when the auction house window opens.
local NEUTRAL_TOWNS = { ["Booty Bay"] = true, ["Gadgetzan"] = true, ["Everlook"] = true }
local currentHouse, currentZone

local function DetectHouse()
  local zone, sub = GetRealZoneText() or "", GetSubZoneText() or ""
  currentZone = sub ~= "" and (sub .. ", " .. zone) or zone
  if NEUTRAL_TOWNS[sub] or NEUTRAL_TOWNS[zone] then
    currentHouse = "neutral"
  else
    currentHouse = string.lower(UnitFactionGroup("player") or "unknown")
  end
end

local function Save(format, data, count, kind)
  if count == 0 then return end
  if not currentHouse then DetectHouse() end
  local scans = AHTRACKER_DB.scans
  table.insert(scans, {
    ts = time(),
    realm = GetRealmName(),
    faction = UnitFactionGroup("player"),
    house = currentHouse,
    zone = currentZone,
    format = format,
    count = count,
    data = data,
  })
  while #scans > MAX_SCANS do table.remove(scans, 1) end
  Print(("saved %s of %d %s at the %s auction house (%d waiting). /reload to send them to the app."):format(
    kind, count, format == 1 and "listings" or "items", currentHouse, #scans))
end

-- Item metadata for the app: category, quality and icon, recorded once per item from the client's own
-- item data (instant lookups, no server queries), plus vendor price and the auction deposit per unit.
-- items[itemId] = "classId,subclassId,quality,iconFileId,equipLoc,vendorPrice,depositPerUnit"
-- ("?" = not known yet) and className["c"] / ["c.s"] = name.
-- Newer clients only provide these under C_Item; older ones only as globals. Use whichever exists.
local C = C_Item or {}
local ItemInfoInstant = C.GetItemInfoInstant or GetItemInfoInstant
local ItemClassInfo = C.GetItemClassInfo or GetItemClassInfo
local ItemSubClassInfo = C.GetItemSubClassInfo or GetItemSubClassInfo
local ItemInfo = C.GetItemInfo or GetItemInfo

local function GetQuality(itemId)
  if C.GetItemQualityByID then return C.GetItemQualityByID(itemId) end
  if ItemInfo then return select(3, ItemInfo(itemId)) end
  return nil
end

local warned = false
local function MissingApi()
  local missing = {}
  if not ItemInfoInstant then table.insert(missing, "GetItemInfoInstant") end
  if not ItemClassInfo then table.insert(missing, "GetItemClassInfo") end
  if not ItemSubClassInfo then table.insert(missing, "GetItemSubClassInfo") end
  return missing
end

-- Jordan always lists for the shortest duration: 2 hours on Forever. WoW duration index 1 = Short
-- (Auctionator's duration value 12, labelled "2" on Forever via Auctionator.Constants.Durations).
local SHORT_DURATION_INDEX, AUCTIONATOR_SHORT_VALUE = 1, 12
local function PostingDuration()
  return SHORT_DURATION_INDEX
end

local function VendorPrice(itemId)
  if not ItemInfo then return nil end
  local sellPrice = select(11, ItemInfo(itemId))
  return sellPrice
end

local function DepositPerUnit(itemId)
  local AH = C_AuctionHouse
  if not (AH and AH.CalculateCommodityDeposit) then return nil end
  local ok, deposit = pcall(AH.CalculateCommodityDeposit, itemId, PostingDuration(), 1)
  return ok and deposit or nil
end

local function RecordItems(itemIds)
  local missing = MissingApi()
  if #missing > 0 then
    if not warned then
      warned = true
      Print("item details unavailable on this client (missing " .. table.concat(missing, ", ") .. "); prices are still saved.")
    end
    return 0
  end
  local items, classes = AHTRACKER_DB.items, AHTRACKER_DB.classes
  local added = 0
  for itemId in pairs(itemIds) do
    local known = items[itemId]
    -- Re-try entries whose quality was not cached yet ("?").
    -- Record new items, re-try unknown ("?") fields, and fill in the vendor price and deposit fields
    -- that entries from older addon versions lack (they have fewer than 7 fields).
    if not known or known:find("%?") or select(2, known:gsub(",", ",")) < 6 then
      local _, _, _, equipLoc, icon, classId, subclassId = ItemInfoInstant(itemId)
      if classId then
        local quality = GetQuality(itemId)
        items[itemId] = classId .. "," .. (subclassId or 0) .. "," .. (quality or "?") .. "," .. (icon or 0) .. "," .. (equipLoc or "")
          .. "," .. (VendorPrice(itemId) or "?") .. "," .. (DepositPerUnit(itemId) or "?")
        if not known then added = added + 1 end
        if not classes[tostring(classId)] then classes[tostring(classId)] = ItemClassInfo(classId) end
        local sk = classId .. "." .. (subclassId or 0)
        if not classes[sk] then classes[sk] = ItemSubClassInfo(classId, subclassId or 0) end
      end
    end
  end
  return added
end

local function ItemIdsOf(rawScan)
  local ids = {}
  for _, entry in ipairs(rawScan) do
    local info = entry.auctionInfo or entry.replicateInfo
    local itemId = (info and info[17]) or (entry.itemKey and entry.itemKey.itemID)
    if itemId and itemId > 0 then ids[itemId] = true end
  end
  return ids
end

local FULL, BROWSE
local listener = {}

function listener:ReceiveEvent(eventName, rawScan)
  if type(rawScan) ~= "table" then return end
  if eventName == FULL or eventName == BROWSE then
    local ok, err = pcall(RecordItems, ItemIdsOf(rawScan))
    if not ok and not warned then
      warned = true
      Print("could not record item details (prices are still saved): " .. tostring(err))
    end
  end
  if eventName == FULL then
    local data, count = EncodeListings(rawScan)
    Save(1, data, count, "full scan")
  elseif eventName == BROWSE then
    local data, count = EncodeSummaries(rawScan)
    Save(2, data, count, "browse scan")
  end
end

-- Inventory: what each character has in bags (and bank, when opened) that could be sold, so the app
-- can compare selling prices across auction houses. Soulbound items are skipped.
-- inventory["Name-Realm"] = { bags = "itemId:count,...", bagsTs = t, bank = "...", bankTs = t }
local function ContainerItems(containerIds)
  local counts = {}
  local C_C = C_Container
  for _, bag in ipairs(containerIds) do
    local slots = (C_C and C_C.GetContainerNumSlots and C_C.GetContainerNumSlots(bag)) or (GetContainerNumSlots and GetContainerNumSlots(bag)) or 0
    for slot = 1, slots do
      local info = C_C and C_C.GetContainerItemInfo and C_C.GetContainerItemInfo(bag, slot)
      if info and info.itemID and not info.isBound then
        counts[info.itemID] = (counts[info.itemID] or 0) + (info.stackCount or 1)
      end
    end
  end
  local parts = {}
  for id, n in pairs(counts) do table.insert(parts, id .. ":" .. n) end
  table.sort(parts)
  return table.concat(parts, ",")
end

local function CharacterKey()
  return (UnitName("player") or "?") .. "-" .. (GetRealmName() or "?")
end

local function ScanBags()
  local ids = {}
  for b = 0, (NUM_BAG_SLOTS or 4) do table.insert(ids, b) end
  local inv = AHTRACKER_DB.inventory
  local me = inv[CharacterKey()] or {}
  me.bags, me.bagsTs = ContainerItems(ids), time()
  inv[CharacterKey()] = me
end

local function ScanBank()
  local ids = { BANK_CONTAINER or -1 }
  local first = (NUM_BAG_SLOTS or 4) + 1
  for b = first, first + (NUM_BANKBAGSLOTS or 6) - 1 do table.insert(ids, b) end
  local inv = AHTRACKER_DB.inventory
  local me = inv[CharacterKey()] or {}
  me.bank, me.bankTs = ContainerItems(ids), time()
  inv[CharacterKey()] = me
end

-- Bags change often; scan at most once every 2 seconds.
local bagScanQueued = false
local function QueueBagScan()
  if bagScanQueued then return end
  bagScanQueued = true
  C_Timer.After(2, function()
    bagScanQueued = false
    pcall(ScanBags)
  end)
end

-- Defined further down; declared here so the login handler can call it.
local ApplyLists

-- Purchases: every confirmed auction-house buy (Auctionator or the default UI) is recorded, giving each
-- item a cost basis (average price paid over the last 14 days) for profit-safe listing prices.
local MAX_PURCHASES = 500
local pending = {}

local function RecordPurchase(itemId, quantity, unitPrice)
  if not (itemId and quantity and quantity > 0 and unitPrice and unitPrice > 0) then return end
  local list = AHTRACKER_DB.purchases
  table.insert(list, { ts = time(), itemId = itemId, qty = quantity, unit = unitPrice, house = currentHouse,
    char = UnitName("player") })
  while #list > MAX_PURCHASES do table.remove(list, 1) end
end

-- What you paid per unit for the units you hold. The app sends the cost of your unsold purchases
-- (TSM's ledger plus these records, oldest sold first) in Lists.lua; purchases recorded here since
-- that file was written are averaged in. Without the app's figure: purchases from the last 14 days.
local function CostBasis(itemId)
  local lists = AHTRACKER_LISTS
  local known = lists and lists.costs and lists.costs[itemId]
  local qty, total = 0, 0
  local since = known and (lists.generated or 0) or (time() - 14 * 86400)
  if known then qty, total = known[2], known[1] * known[2] end
  for _, p in ipairs(AHTRACKER_DB.purchases or {}) do
    if p.itemId == itemId and p.ts > since then
      qty, total = qty + p.qty, total + p.qty * p.unit
    end
  end
  if qty == 0 then return nil end
  return math.ceil(total / qty), qty
end

local function HookPurchases()
  local AH = C_AuctionHouse
  if not AH or not hooksecurefunc then return end
  if AH.StartCommoditiesPurchase then
    hooksecurefunc(AH, "StartCommoditiesPurchase", function(itemId, quantity)
      pending.commodity = { itemId = itemId, qty = quantity }
    end)
  end
  if AH.ConfirmCommoditiesPurchase then
    hooksecurefunc(AH, "ConfirmCommoditiesPurchase", function(itemId, quantity)
      local c = pending.commodity
      if c and c.itemId == itemId then c.qty, c.confirmed = quantity, true end
    end)
  end
  if AH.PlaceBid then
    hooksecurefunc(AH, "PlaceBid", function(auctionId, amount)
      -- Only a buyout counts as a purchase; find the auction in the open item search results.
      local key = pending.itemKey
      if not (key and AH.GetNumItemSearchResults and AH.GetItemSearchResultInfo) then return end
      for i = 1, AH.GetNumItemSearchResults(key) do
        local r = AH.GetItemSearchResultInfo(key, i)
        if r and r.auctionID == auctionId and r.buyoutAmount and amount >= r.buyoutAmount then
          local qty = math.max(1, r.quantity or 1)
          pending.bids = pending.bids or {}
          pending.bids[auctionId] = { itemId = key.itemID, qty = qty, unit = math.floor(r.buyoutAmount / qty) }
          return
        end
      end
    end)
  end
end

local function OnAuctionEvent(event, ...)
  if event == "COMMODITY_PRICE_UPDATED" then
    local unitPrice, totalPrice = ...
    if pending.commodity then pending.commodity.unit, pending.commodity.total = unitPrice, totalPrice end
  elseif event == "COMMODITY_PURCHASE_SUCCEEDED" then
    local c = pending.commodity
    if c and c.confirmed then
      RecordPurchase(c.itemId, c.qty, c.total and math.ceil(c.total / c.qty) or c.unit)
      Print(("recorded purchase: %d x item %d at %s each."):format(c.qty, c.itemId, GetCoinTextureString and GetCoinTextureString(c.total and math.ceil(c.total / c.qty) or c.unit or 0) or tostring(c.unit)))
    end
    pending.commodity = nil
  elseif event == "COMMODITY_PURCHASE_FAILED" then
    pending.commodity = nil
  elseif event == "ITEM_SEARCH_RESULTS_UPDATED" then
    local itemKey = ...
    pending.itemKey = itemKey
  elseif event == "AUCTION_HOUSE_PURCHASE_COMPLETED" then
    local auctionId = ...
    local b = pending.bids and pending.bids[auctionId]
    if b then
      RecordPurchase(b.itemId, b.qty, b.unit)
      pending.bids[auctionId] = nil
    end
  end
end

-- Selling-tab pricing: when you pick an item in Auctionator's Selling tab, replace Auctionator's price
-- with the app's target sell price for this house (Lists.lua sellTargets). Never below the target;
-- if the cheapest competing listing is above the target, undercut that instead.
local SELL = { itemId = nil, location = nil, source = {} }

local function Money(copper)
  if GetCoinTextureString then return GetCoinTextureString(copper) end
  return ("%dg %ds %dc"):format(math.floor(copper / 10000), math.floor(copper / 100) % 100, copper % 100)
end

local function CheapestCompeting(itemId, itemKey)
  local AH = C_AuctionHouse
  if not AH then return nil end
  if itemKey and AH.GetItemSearchResultInfo then
    local r = AH.GetItemSearchResultInfo(itemKey, 1)
    if r and r.buyoutAmount and r.buyoutAmount > 0 then return math.floor(r.buyoutAmount / math.max(1, r.quantity or 1)) end
  elseif AH.GetCommoditySearchResultInfo then
    local r = AH.GetCommoditySearchResultInfo(itemId, 1)
    if r and r.unitPrice and r.unitPrice > 0 then return r.unitPrice end
  end
  return nil
end

-- Deposit per unit for this listing, exactly as WoW will charge it at Auctionator's duration.
local function ListingDeposit(itemId, location)
  local AH = C_AuctionHouse
  if not AH then return 0 end
  local duration = PostingDuration()
  location = location or SELL.location
  if location and AH.GetItemCommodityStatus and AH.CalculateItemDeposit
     and AH.GetItemCommodityStatus(location) ~= (Enum and Enum.ItemCommodityStatus and Enum.ItemCommodityStatus.Commodity) then
    local ok, d = pcall(AH.CalculateItemDeposit, location, duration, 1)
    if ok and d then return d end
  end
  return DepositPerUnit(itemId) or 0
end

local function Settings()
  local s = AHTRACKER_LISTS and AHTRACKER_LISTS.settings or {}
  local cut = s.cuts and s.cuts[currentHouse or ""] or (currentHouse == "neutral" and 0.15 or 0.05)
  return s.minMargin or 0.1, cut
end

-- "profit 12s 3c per unit (18%)" in green, or "loss ..." in red, at a listing price per unit: after
-- this house's AH cut and the listing deposit (lost if the auction expires). Ends with the total for
-- the stack in brackets (x 1 for a single item). Nil if the cost is unknown.
local GREEN, RED = "|cff33dd33", "|cffff4444"
local function ProfitText(itemId, price, location, qty)
  local cost = CostBasis(itemId)
  if not cost or not price or price <= 0 then return nil end
  local _, cut = Settings()
  local profit = math.floor(price * (1 - cut) - cost - ListingDeposit(itemId, location))
  local pct = cost > 0 and math.floor(profit / cost * 100 + 0.5) or 0
  local color = profit >= 0 and GREEN or RED
  qty = math.max(1, qty or 1)
  local total = (" %s(%s after deductions x %d: %s)|r"):format(color, profit >= 0 and "profit" or "loss", qty, Money(math.abs(profit) * qty))
  return ("%s%s %s per unit (%d%%)|r after cut and deposit, you paid %s%s"):format(
    color, profit >= 0 and "profit" or "loss", Money(math.abs(profit)), pct, Money(cost), total)
end

-- How many of an item you carry (the stack you are about to post).
local function BagCount(itemId)
  local count = (C_Item and C_Item.GetItemCount and C_Item.GetItemCount(itemId)) or (GetItemCount and GetItemCount(itemId))
  return tonumber(count) or 0
end

local function ApplySellPrice(itemId, itemKey)
  if AHTRACKER_DB.autoprice == false or itemId ~= SELL.itemId then return end
  local targets = AHTRACKER_LISTS and AHTRACKER_LISTS.sellTargets and AHTRACKER_LISTS.sellTargets[currentHouse or ""]
  local target = targets and targets[itemId]
  local cost = CostBasis(itemId)
  if not target and not cost then return end -- nothing known about this item: keep Auctionator's price
  local minMargin, cut = Settings()
  local deposit = ListingDeposit(itemId)
  -- Lowest price that still makes the minimum margin on what you paid, after the cut, even if the
  -- deposit is lost once (it is refunded when the auction sells).
  local floor = cost and math.ceil((cost * (1 + minMargin) + deposit) / (1 - cut)) or nil
  local cheapest = CheapestCompeting(itemId, itemKey)
  local price, why = target or floor, target and "AH Tracker target" or "your minimum profitable price"
  if floor and price < floor then price, why = floor, "your minimum profitable price" end
  if cheapest and cheapest - 1 > price then
    price, why = cheapest - 1, "undercutting the cheapest listing, which is higher"
  end
  if floor and cheapest and cheapest < floor then
    Print(("warning: the cheapest listing (%s) is below your break-even-plus-margin price (%s). Listing at %s may take a while; consider waiting for its dear hours."):format(
      Money(cheapest), Money(floor), Money(price)))
  end
  Auctionator.EventBus:RegisterSource(SELL.source, "AHTracker")
  Auctionator.EventBus:Fire(SELL.source, Auctionator.Selling.Events.PriceSelected, { buyout = price }, false)
  local name = (C_Item and C_Item.GetItemNameByID and C_Item.GetItemNameByID(itemId)) or ("item " .. itemId)
  local profit = ProfitText(itemId, price, nil, BagCount(itemId))
  Print(("priced %s at %s (%s%s)%s"):format(name, Money(price), why,
    cheapest and (", cheapest listing " .. Money(cheapest)) or "", profit and (": " .. profit) or "."))
end

-- After you post (at whatever price ends up in Auctionator's box): the profit at that price.
local function ReportPosted(info)
  if not (info and info.itemLink and info.buyoutAmount and info.buyoutAmount > 0) then return end
  local itemId = tonumber(info.itemLink:match("item:(%d+)"))
  local profit = itemId and ProfitText(itemId, info.buyoutAmount, SELL.itemId == itemId and SELL.location or nil, info.quantity)
  if profit then
    Print(("posted %s x%d at %s: %s."):format(info.itemLink, info.quantity or 1, Money(info.buyoutAmount), profit))
  end
end

-- TSM: the app sets up Auctioning operations "AHT 2h ..." (one per posting quantity) whose lowest price
-- is what you paid plus your margin after the AH cut. TSM cannot tell which auction house you are at, so
-- on opening one this rewrites that price for the house's cut (TSM reads its operations live from
-- TradeSkillMasterDB).
local TSM_OPERATION_PREFIX = "AHT 2h"
local tunedFor
local function TuneTSM()
  local db = TradeSkillMasterDB
  if type(db) ~= "table" or not currentHouse or tunedFor == currentHouse then return end
  local minMargin, cut = Settings()
  -- TSM's recent value, not its market value (which runs well above real prices).
  local formula = ("check(smartavgbuy, max(%.4f * smartavgbuy, vendorsell), max(0.8 * first(dbrecent, dbminbuyout), vendorsell))"):format((1 + minMargin) / (1 - cut))
  local changed = false
  for key, ops in pairs(db) do
    if type(key) == "string" and key:match("^p@.-@userData@operations$") and type(ops) == "table" then
      for name, op in pairs(type(ops.Auctioning) == "table" and ops.Auctioning or {}) do
        if type(name) == "string" and name:sub(1, #TSM_OPERATION_PREFIX) == TSM_OPERATION_PREFIX and type(op) == "table"
           and op.minPrice ~= formula then
          op.minPrice, changed = formula, true
        end
      end
    end
  end
  tunedFor = currentHouse
  if changed then
    Print(("TSM \"%s ...\" operations set for this auction house: lowest price = paid + %d%% after its %d%% cut."):format(TSM_OPERATION_PREFIX, math.floor(minMargin * 100 + 0.5), math.floor(cut * 100 + 0.5)))
  end
end

local sellListener = {}
function sellListener:ReceiveEvent(event, ...)
  if event == Auctionator.Selling.Events.AuctionCreated then
    pcall(ReportPosted, ...)
  elseif event == Auctionator.Selling.Events.BagItemClicked then
    local info = ...
    SELL.itemId = info and info.itemID
    SELL.location = info and info.location
  elseif event == Auctionator.AH.Events.CommoditySearchResultsReady then
    local itemId = ...
    -- Auctionator prices the item when these results arrive; set ours just after it.
    C_Timer.After(0.3, function() pcall(ApplySellPrice, itemId, nil) end)
  elseif event == Auctionator.AH.Events.ItemSearchResultsReady then
    local itemKey = ...
    if itemKey then C_Timer.After(0.3, function() pcall(ApplySellPrice, itemKey.itemID, itemKey) end) end
  end
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("AUCTION_HOUSE_SHOW")
for _, e in ipairs({ "BAG_UPDATE_DELAYED", "BANKFRAME_OPENED", "PLAYERBANKSLOTS_CHANGED", "COMMODITY_PRICE_UPDATED", "COMMODITY_PURCHASE_SUCCEEDED", "COMMODITY_PURCHASE_FAILED",
                     "ITEM_SEARCH_RESULTS_UPDATED", "AUCTION_HOUSE_PURCHASE_COMPLETED" }) do
  pcall(frame.RegisterEvent, frame, e) -- events this client lacks are skipped
end
frame:SetScript("OnEvent", function(_, event, ...)
  if event == "AUCTION_HOUSE_SHOW" then
    DetectHouse()
    pcall(TuneTSM)
    return
  elseif event == "BAG_UPDATE_DELAYED" then
    if AHTRACKER_DB then QueueBagScan() end
    return
  elseif event == "BANKFRAME_OPENED" or event == "PLAYERBANKSLOTS_CHANGED" then
    if AHTRACKER_DB then pcall(ScanBank) end
    return
  elseif event ~= "PLAYER_LOGIN" then
    pcall(OnAuctionEvent, event, ...)
    return
  end
  AHTRACKER_DB = AHTRACKER_DB or {}
  AHTRACKER_DB.scans = AHTRACKER_DB.scans or {}
  AHTRACKER_DB.items = AHTRACKER_DB.items or {}
  AHTRACKER_DB.classes = AHTRACKER_DB.classes or {}
  AHTRACKER_DB.purchases = AHTRACKER_DB.purchases or {}
  AHTRACKER_DB.inventory = AHTRACKER_DB.inventory or {}
  HookPurchases()
  pcall(ScanBags)
  -- Make Auctionator's Selling tab default to 2-hour listings, matching AH Tracker's prices.
  local opt = Auctionator.Config and Auctionator.Config.Options and Auctionator.Config.Options.AUCTION_DURATION
  if opt and Auctionator.Config.Get and Auctionator.Config.Set and Auctionator.Config.Get(opt) ~= AUCTIONATOR_SHORT_VALUE then
    Auctionator.Config.Set(opt, AUCTIONATOR_SHORT_VALUE)
    Print("set Auctionator's default listing duration to 2 hours.")
  end
  if not (Auctionator and Auctionator.EventBus) then
    Print("Auctionator not found; scans will not be saved.")
    return
  end
  local events = {}
  if Auctionator.FullScan and Auctionator.FullScan.Events then
    FULL = Auctionator.FullScan.Events.ScanComplete
    table.insert(events, FULL)
  end
  if Auctionator.IncrementalScan and Auctionator.IncrementalScan.Events then
    BROWSE = Auctionator.IncrementalScan.Events.ScanComplete
    table.insert(events, BROWSE)
  end
  if #events == 0 then
    Print("Auctionator scan events not found; scans will not be saved.")
    return
  end
  Auctionator.EventBus:Register(listener, events)
  -- Selling-tab pricing needs Auctionator's modern AH selling events.
  if AHTRACKER_DB.autoprice == nil then AHTRACKER_DB.autoprice = true end
  if Auctionator.Selling and Auctionator.Selling.Events and Auctionator.Selling.Events.PriceSelected
     and Auctionator.AH and Auctionator.AH.Events and Auctionator.AH.Events.CommoditySearchResultsReady then
    local sellEvents = {
      Auctionator.Selling.Events.BagItemClicked,
      Auctionator.AH.Events.CommoditySearchResultsReady,
      Auctionator.AH.Events.ItemSearchResultsReady,
    }
    -- Posting reports profit at the posted price (older Auctionator versions lack this event).
    if Auctionator.Selling.Events.AuctionCreated then table.insert(sellEvents, Auctionator.Selling.Events.AuctionCreated) end
    Auctionator.EventBus:Register(sellListener, sellEvents)
  end
  -- Auctionator finishes loading its saved lists at login too; build ours a moment later.
  C_Timer.After(3, function()
    local ok, err = pcall(ApplyLists, false)
    if not ok then Print("could not create shopping lists: " .. tostring(err)) end
  end)
end)

-- Shopping lists from the app (Lists.lua, regenerated after each statistics refresh): turned into
-- Auctionator shopping lists whose searches carry an exact item name and a maximum buy price.
local LIST_PREFIX = "AHT "
-- Time-of-day flip lists are split and tagged at the front: "[TG] AHT ..." (trade goods), "[BOE] AHT ..." (other items).
local function IsAppList(name)
  return name:sub(1, #LIST_PREFIX) == LIST_PREFIX or name:match("^%[%u+%] AHT ") ~= nil
end

function ApplyLists(verbose) -- assigns the local declared above
  if not (AHTRACKER_LISTS and AHTRACKER_LISTS.lists) then return end
  local api = Auctionator and Auctionator.API and Auctionator.API.v1
  if not (api and api.CreateShoppingList and api.ConvertToSearchString) then
    if verbose then Print("Auctionator's shopping list API was not found; lists not created.") end
    return
  end
  local made, items = 0, 0
  local wanted = {}
  for _, list in ipairs(AHTRACKER_LISTS.lists) do
    local searches = {}
    for _, item in ipairs(list.items) do
      table.insert(searches, api.ConvertToSearchString("AHTracker", {
        searchString = item.name, isExact = true, maxPrice = item.maxPrice,
      }))
    end
    if #searches > 0 then
      wanted[list.name] = true -- an empty list today is removed below rather than left with stale prices
      api.CreateShoppingList("AHTracker", list.name, searches)
      made, items = made + 1, items + #searches
    end
  end
  -- Remove AHT lists the app no longer produces (for example a list that is empty today).
  local manager = Auctionator.Shopping and Auctionator.Shopping.ListManager
  if manager and manager.GetCount and manager.GetByIndex and manager.Delete then
    for i = manager:GetCount(), 1, -1 do
      local l = manager:GetByIndex(i)
      local name = l and l.GetName and l:GetName()
      if name and IsAppList(name) and not wanted[name] then manager:Delete(name) end
    end
  end
  if verbose or made > 0 then
    local age = AHTRACKER_LISTS.generated > 0 and date("%Y-%m-%d %H:%M", AHTRACKER_LISTS.generated) or "never"
    Print(("updated %d Auctionator shopping lists (%d items, prices from %s)."):format(made, items, age))
  end
end

SLASH_AHTRACKER1 = "/ahtracker"
-- Mailbox: "Send AH purchases" button. Mails the stacks of items this character bought on the auction
-- house since its last send (or the last 24 hours, the first time) to your other character, 12 stacks
-- per mail (WoW's limit). WoW needs a click for every mail sent, so each click sends one mail.
local MAIL = { button = nil, sending = false }

local function MyName() return UnitName("player") or "?" end

-- Your other character: set with /ahtracker mailto <name>, otherwise the other character AH Tracker
-- has seen on this account (from its bag scans).
local function MailTarget()
  AHTRACKER_DB.mailTo = AHTRACKER_DB.mailTo or {}
  local chosen = AHTRACKER_DB.mailTo[MyName()]
  if chosen and chosen ~= "" then return chosen end
  local others = {}
  for key in pairs(AHTRACKER_DB.inventory or {}) do
    local name = type(key) == "string" and key:match("^(.-)%-") or nil
    if name and name ~= MyName() then table.insert(others, name) end
  end
  table.sort(others)
  return others[1]
end

-- Item ids this character bought since its last send.
local function PendingPurchaseIds()
  AHTRACKER_DB.mailedUpTo = AHTRACKER_DB.mailedUpTo or {}
  local since = AHTRACKER_DB.mailedUpTo[MyName()] or (time() - 24 * 3600)
  local ids = {}
  for _, p in ipairs(AHTRACKER_DB.purchases or {}) do
    if p.ts > since and (p.char == nil or p.char == MyName()) then ids[p.itemId] = true end
  end
  return ids
end

-- Bag slots holding those items (tradeable stacks only).
local function PendingSlots()
  local ids, slots = PendingPurchaseIds(), {}
  local C_C = C_Container
  for bag = 0, (NUM_BAG_SLOTS or 4) do
    local n = (C_C and C_C.GetContainerNumSlots and C_C.GetContainerNumSlots(bag)) or 0
    for slot = 1, n do
      local info = C_C.GetContainerItemInfo and C_C.GetContainerItemInfo(bag, slot)
      if info and info.itemID and ids[info.itemID] and not info.isBound and not info.isLocked then
        table.insert(slots, { bag = bag, slot = slot })
      end
    end
  end
  return slots
end

local function UpdateMailButton()
  local b = MAIL.button
  if not b then return end
  local target, n = MailTarget(), #PendingSlots()
  if not target then
    b:SetText("AHT: no other character known (/ahtracker mailto Name)")
    b:Disable()
  elseif n == 0 then
    b:SetText(("AHT: no AH purchases to send to %s"):format(target))
    b:Disable()
  else
    b:SetText(("AHT: Send AH purchases -> %s (%d stack%s)"):format(target, n, n == 1 and "" or "s"))
    b:Enable()
  end
end

local function SendPurchaseBatch()
  local target = MailTarget()
  local slots = PendingSlots()
  if not target or #slots == 0 or MAIL.sending then return end
  if MailFrameTab_OnClick then MailFrameTab_OnClick(nil, 2) end -- the Send Mail tab
  if ClearSendMail then ClearSendMail() end
  local max = ATTACHMENTS_MAX_SEND or 12
  local attached = 0
  for i = 1, math.min(max, #slots) do
    C_Container.PickupContainerItem(slots[i].bag, slots[i].slot)
    ClickSendMailItemButton(i)
    attached = attached + 1
  end
  MAIL.sending, MAIL.count = true, attached
  SendMail(target, "AH purchases", "")
end

local function OnMailEvent(event)
  if event == "MAIL_SHOW" then
    if not MAIL.button and MailFrame then
      local b = CreateFrame("Button", "AHTrackerMailButton", MailFrame, "UIPanelButtonTemplate")
      b:SetSize(330, 24)
      b:SetPoint("BOTTOM", MailFrame, "TOP", 0, 4)
      b:SetScript("OnClick", function() pcall(SendPurchaseBatch) end)
      MAIL.button = b
    end
    if MAIL.button then MAIL.button:Show() end
    UpdateMailButton()
  elseif event == "MAIL_SEND_SUCCESS" and MAIL.sending then
    MAIL.sending = false
    Print(("mailed %d stack(s) of AH purchases to %s."):format(MAIL.count or 0, MailTarget() or "?"))
    if #PendingSlots() == 0 then AHTRACKER_DB.mailedUpTo[MyName()] = time() end
    UpdateMailButton()
  elseif event == "MAIL_FAILED" and MAIL.sending then
    MAIL.sending = false
    Print("mail was not sent; check the name and that you can afford the postage.")
    UpdateMailButton()
  elseif event == "BAG_UPDATE_DELAYED" and MailFrame and MailFrame:IsShown() then
    UpdateMailButton()
  end
end

local mailFrame = CreateFrame("Frame")
for _, e in ipairs({ "MAIL_SHOW", "MAIL_SEND_SUCCESS", "MAIL_FAILED", "BAG_UPDATE_DELAYED" }) do pcall(mailFrame.RegisterEvent, mailFrame, e) end
mailFrame:SetScript("OnEvent", function(_, event) pcall(OnMailEvent, event) end)

SlashCmdList.AHTRACKER = function(msg)
  local to = msg and msg:match("^%s*mailto%s*(.-)%s*$")
  if to then
    AHTRACKER_DB.mailTo = AHTRACKER_DB.mailTo or {}
    AHTRACKER_DB.mailTo[MyName()] = to ~= "" and to or nil
    Print("AH purchases from " .. MyName() .. " will be mailed to " .. (MailTarget() or "nobody yet") .. ".")
    UpdateMailButton()
    return
  end
  local onoff = msg and msg:lower():match("^%s*autoprice%s*(%a*)")
  if onoff then
    if onoff == "on" or onoff == "off" then AHTRACKER_DB.autoprice = (onoff == "on") end
    Print("Selling-tab pricing is " .. (AHTRACKER_DB.autoprice == false and "off" or "on") .. ". Use /ahtracker autoprice on|off.")
    return
  end
  if msg and msg:lower():match("^%s*lists") then
    local ok, err = pcall(ApplyLists, true)
    if not ok then Print("could not create shopping lists: " .. tostring(err)) end
    return
  end
  local scans = AHTRACKER_DB and AHTRACKER_DB.scans or {}
  local last = scans[#scans]
  Print(("%d scan(s) waiting for the app%s."):format(#scans, last and
    (", latest " .. date("%Y-%m-%d %H:%M", last.ts) .. " (" .. (last.format == 1 and "full" or "browse") .. ", " .. last.count .. ")") or ""))
end
