// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").FunctionRunResult} CartTransformRunResult
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

const DEFAULT_MIN_LENGTH = 0.1;
const DEFAULT_MAX_LENGTH = 100;
const DEFAULT_MIN_WIDTH = 0.1;
const DEFAULT_MAX_WIDTH = 100;
const AREA_TOLERANCE = 0.01;
const MM_PER_METER = 1000;
const EXPANDED_ITEM_QUANTITY_PER_PARENT = 1;

/**
 * @param {string | null | undefined} value
 */
function parseDecimal(value) {
  if (typeof value !== "string") return null;
  const trimmedValue = value.trim();
  if (!trimmedValue) return null;

  const parsedValue = Number.parseFloat(trimmedValue);
  if (!Number.isFinite(parsedValue)) return null;

  return parsedValue;
}

/**
 * @param {string | null | undefined} value
 */
function parsePositiveDecimal(value) {
  const parsedValue = parseDecimal(value);
  if (parsedValue === null || parsedValue <= 0) return null;

  return parsedValue;
}

/**
 * @param {string | null | undefined} value
 */
function parseBoolean(value) {
  return value === "true";
}

/**
 * @param {string | null | undefined} metersValue
 * @param {string | null | undefined} millimetersValue
 */
function parseMetersFromAttribute(metersValue, millimetersValue) {
  const meters = parsePositiveDecimal(metersValue);
  if (meters !== null) return meters;

  const millimeters = parsePositiveDecimal(millimetersValue);
  if (millimeters === null) return null;

  return millimeters / MM_PER_METER;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function isWithinRange(value, min, max) {
  return value >= min && value <= max;
}

/**
 * @param {number} first
 * @param {number} second
 */
function areClose(first, second) {
  return Math.abs(first - second) <= AREA_TOLERANCE;
}

/**
 * @param {number} amount
 */
function toMoneyString(amount) {
  return (Math.round(amount * 100) / 100).toFixed(2);
}

/**
 * @param {string} key
 * @param {string | null | undefined} value
 */
function buildAttribute(key, value) {
  if (typeof value !== "string") return null;
  return { key, value };
}

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  if (!input.cart?.lines?.length) {
    return NO_CHANGES;
  }

  const operations = [];

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;
    if (line.parentRelationship?.parent?.id) continue;

    const product = line.merchandise.product;
    const enableSqmPricing = parseBoolean(product.enableSqmPricing?.value);
    if (!enableSqmPricing) continue;

    const length = parseMetersFromAttribute(line.length?.value, line.lengthMm?.value);
    const width = parseMetersFromAttribute(line.width?.value, line.widthMm?.value);
    const providedArea = parsePositiveDecimal(line.area?.value);
    if ((length === null || width === null) && providedArea === null) continue;

    const baseUnitPrice = parsePositiveDecimal(line.cost?.amountPerQuantity?.amount);
    if (baseUnitPrice === null) continue;

    const minLength = parsePositiveDecimal(product.minLength?.value) ?? DEFAULT_MIN_LENGTH;
    const maxLength = parsePositiveDecimal(product.maxLength?.value) ?? DEFAULT_MAX_LENGTH;
    const minWidth = parsePositiveDecimal(product.minWidth?.value) ?? DEFAULT_MIN_WIDTH;
    const maxWidth = parsePositiveDecimal(product.maxWidth?.value) ?? DEFAULT_MAX_WIDTH;

    if (
      length !== null &&
      width !== null &&
      (!isWithinRange(length, minLength, maxLength) || !isWithinRange(width, minWidth, maxWidth))
    ) {
      continue;
    }

    const calculatedArea = length !== null && width !== null ? length * width : null;
    const area =
      providedArea !== null
        ? calculatedArea !== null && !areClose(providedArea, calculatedArea)
          ? calculatedArea
          : providedArea
        : calculatedArea;

    if (area === null || !Number.isFinite(area) || area <= 0) continue;

    const newUnitPrice = area * baseUnitPrice;
    if (!Number.isFinite(newUnitPrice) || newUnitPrice <= 0) continue;

    const parsedLengthMm = parsePositiveDecimal(line.lengthMm?.value);
    const parsedWidthMm = parsePositiveDecimal(line.widthMm?.value);

    const attributes = [
      buildAttribute(
        "length_mm",
        parsedLengthMm !== null
          ? toMoneyString(parsedLengthMm)
          : length !== null
            ? toMoneyString(length * MM_PER_METER)
            : null,
      ),
      buildAttribute(
        "width_mm",
        parsedWidthMm !== null
          ? toMoneyString(parsedWidthMm)
          : width !== null
            ? toMoneyString(width * MM_PER_METER)
            : null,
      ),
      buildAttribute("length", line.length?.value ?? (length !== null ? toMoneyString(length) : null)),
      buildAttribute("width", line.width?.value ?? (width !== null ? toMoneyString(width) : null)),
      buildAttribute("area", toMoneyString(area)),
    ].filter(Boolean);

    operations.push({
      lineExpand: {
        cartLineId: line.id,
        expandedCartItems: [
          {
            merchandiseId: line.merchandise.id,
            // Expanded item quantity is per parent line unit. Using line.quantity here
            // causes cart quantity to be applied twice.
            quantity: EXPANDED_ITEM_QUANTITY_PER_PARENT,
            ...(attributes.length > 0 ? { attributes } : {}),
            price: {
              adjustment: {
                fixedPricePerUnit: {
                  amount: toMoneyString(newUnitPrice),
                },
              },
            },
          },
        ],
      },
    });
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
