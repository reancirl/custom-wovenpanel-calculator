import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

type ProductConfig = {
  id: string;
  title: string;
  handle: string;
  status: string;
  enableSqmPricing: boolean;
  minLength: string;
  maxLength: string;
  minWidth: string;
  maxWidth: string;
};

type LoaderData = {
  products: ProductConfig[];
};

type ActionData = {
  ok: boolean;
  message: string;
};

type ProductMetafieldNode = {
  value: string | null;
} | null;

type ProductNode = {
  id: string;
  title: string;
  handle: string;
  status: string;
  enableSqmPricing: ProductMetafieldNode;
  minLength: ProductMetafieldNode;
  maxLength: ProductMetafieldNode;
  minWidth: ProductMetafieldNode;
  maxWidth: ProductMetafieldNode;
};

type ProductEdge = {
  node: ProductNode;
};

type RowState = {
  key: string;
  productQuery: string;
  productId: string;
  minLength: string;
  maxLength: string;
  minWidth: string;
  maxWidth: string;
};

const MM_PER_METER = 1000;
const LEGACY_MM_COMPAT_THRESHOLD_METERS = 100;
const DEFAULT_MIN_LENGTH_METERS = 0.1;
const DEFAULT_MAX_LENGTH_METERS = 100;
const DEFAULT_MIN_WIDTH_METERS = 0.1;
const DEFAULT_MAX_WIDTH_METERS = 100;
const METAFIELDS_SET_BATCH_LIMIT = 25;
const MAX_PRODUCT_MATCH_OPTIONS = 80;
const SQM_CART_TRANSFORM_FUNCTION_HANDLE = "sqm-pricing-function";

const PRODUCT_QUERY = `#graphql
  query SqmPricingProducts {
    products(first: 250, sortKey: TITLE) {
      edges {
        node {
          id
          title
          handle
          status
          enableSqmPricing: metafield(namespace: "custom", key: "enable_sqm_pricing") {
            value
          }
          minLength: metafield(namespace: "custom", key: "min_length") {
            value
          }
          maxLength: metafield(namespace: "custom", key: "max_length") {
            value
          }
          minWidth: metafield(namespace: "custom", key: "min_width") {
            value
          }
          maxWidth: metafield(namespace: "custom", key: "max_width") {
            value
          }
        }
      }
    }
  }
`;

const SET_METAFIELDS_MUTATION = `#graphql
  mutation SetSqmMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }
`;

const ENSURE_CART_TRANSFORM_MUTATION = `#graphql
  mutation EnsureSqmCartTransform($functionHandle: String!, $blockOnFailure: Boolean) {
    cartTransformCreate(functionHandle: $functionHandle, blockOnFailure: $blockOnFailure) {
      cartTransform {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FIND_SQM_FUNCTION_QUERY = `#graphql
  query FindSqmCartTransformFunction {
    shopifyFunctions(first: 50) {
      edges {
        node {
          id
          apiType
          title
        }
      }
    }
  }
`;

const ENSURE_CART_TRANSFORM_BY_ID_MUTATION = `#graphql
  mutation EnsureSqmCartTransformById($functionId: String!, $blockOnFailure: Boolean) {
    cartTransformCreate(functionId: $functionId, blockOnFailure: $blockOnFailure) {
      cartTransform {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ACTIVE_CART_TRANSFORM_QUERY = `#graphql
  query ActiveCartTransform {
    cartTransforms(first: 1) {
      edges {
        node {
          id
          functionId
        }
      }
    }
  }
`;

function parsePositiveDecimal(value: FormDataEntryValue | null): number | null {
  if (value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  return parsed;
}

function toDecimalString(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return rounded.toString();
}

function metersToMillimeters(value: number): number {
  return value * MM_PER_METER;
}

function millimetersToMeters(value: number): number {
  return value / MM_PER_METER;
}

function toUiMillimeters(storedMetersValue: string | null | undefined, fallbackMeters: number): string {
  const parsedMeters = parsePositiveDecimal(storedMetersValue ?? null);
  if (parsedMeters === null) {
    return toDecimalString(metersToMillimeters(fallbackMeters));
  }

  // Backward compatibility: previous UI accepted mm while labeled as meters.
  if (parsedMeters >= LEGACY_MM_COMPAT_THRESHOLD_METERS) {
    return toDecimalString(parsedMeters);
  }

  return toDecimalString(metersToMillimeters(parsedMeters));
}

function buildProductLabel(product: ProductConfig): string {
  return `${product.title} (${product.handle})`;
}

function createEmptyRow(key: string): RowState {
  return {
    key,
    productQuery: "",
    productId: "",
    minLength: toDecimalString(metersToMillimeters(DEFAULT_MIN_LENGTH_METERS)),
    maxLength: toDecimalString(metersToMillimeters(DEFAULT_MAX_LENGTH_METERS)),
    minWidth: toDecimalString(metersToMillimeters(DEFAULT_MIN_WIDTH_METERS)),
    maxWidth: toDecimalString(metersToMillimeters(DEFAULT_MAX_WIDTH_METERS)),
  };
}

function buildInitialRows(products: ProductConfig[]): RowState[] {
  const enabledRows = products
    .filter((product) => product.enableSqmPricing)
    .map((product, index) => ({
      key: `enabled-${index}-${product.id}`,
      productQuery: buildProductLabel(product),
      productId: product.id,
      minLength: toUiMillimeters(product.minLength, DEFAULT_MIN_LENGTH_METERS),
      maxLength: toUiMillimeters(product.maxLength, DEFAULT_MAX_LENGTH_METERS),
      minWidth: toUiMillimeters(product.minWidth, DEFAULT_MIN_WIDTH_METERS),
      maxWidth: toUiMillimeters(product.maxWidth, DEFAULT_MAX_WIDTH_METERS),
    }));

  return enabledRows.length > 0 ? enabledRows : [createEmptyRow("row-0")];
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

type EnsureCartTransformResult = {
  ok: boolean;
  message?: string;
};

type ShopifyFunctionNode = {
  id: string;
  apiType: string;
  title: string;
};

async function isSqmCartTransformAlreadyActive(admin: { graphql: Function }): Promise<boolean> {
  const [sqmFunctionId, transformResponse] = await Promise.all([
    findSqmCartTransformFunctionId(admin),
    admin.graphql(ACTIVE_CART_TRANSFORM_QUERY),
  ]);

  if (!sqmFunctionId) return false;

  const transformResponseJson = await transformResponse.json();
  const topLevelErrors = transformResponseJson.errors ?? [];
  if (topLevelErrors.length > 0) return false;

  const activeTransformFunctionId =
    transformResponseJson.data?.cartTransforms?.edges?.[0]?.node?.functionId ?? null;

  return activeTransformFunctionId === sqmFunctionId;
}

async function findSqmCartTransformFunctionId(admin: { graphql: Function }): Promise<string | null> {
  const response = await admin.graphql(FIND_SQM_FUNCTION_QUERY);
  const responseJson = await response.json();
  const topLevelErrors = responseJson.errors ?? [];
  if (topLevelErrors.length > 0) return null;

  const edges = responseJson.data?.shopifyFunctions?.edges ?? [];
  for (const edge of edges) {
    const node = edge?.node as ShopifyFunctionNode | undefined;
    if (!node) continue;
    if (node.apiType === "cart_transform" && node.title === SQM_CART_TRANSFORM_FUNCTION_HANDLE) {
      return node.id;
    }
  }

  return null;
}

async function ensureSqmCartTransformByFunctionId(
  admin: { graphql: Function },
  functionId: string,
): Promise<EnsureCartTransformResult> {
  const response = await admin.graphql(ENSURE_CART_TRANSFORM_BY_ID_MUTATION, {
    variables: {
      functionId,
      blockOnFailure: false,
    },
  });
  const responseJson = await response.json();
  const topLevelErrors = responseJson.errors ?? [];

  if (topLevelErrors.length > 0) {
    return {
      ok: false,
      message: topLevelErrors[0]?.message ?? "Unable to activate cart transform by function ID.",
    };
  }

  const userErrors = responseJson.data?.cartTransformCreate?.userErrors ?? [];
  if (userErrors.length === 0) {
    return { ok: true };
  }

  const normalizedMessages = userErrors
    .map((error: { message?: string }) => String(error?.message ?? ""))
    .filter(Boolean)
    .join(" ");

  if (/already exists|only.*cart transform/i.test(normalizedMessages)) {
    if (await isSqmCartTransformAlreadyActive(admin)) {
      return { ok: true };
    }

    return {
      ok: false,
      message:
        "Another cart transform is already active in this store. Remove or disable the existing cart transform, then save rows again.",
    };
  }

  return {
    ok: false,
    message: userErrors[0]?.message ?? "Unable to activate cart transform by function ID.",
  };
}

async function ensureSqmCartTransform(admin: { graphql: Function }): Promise<EnsureCartTransformResult> {
  try {
    const response = await admin.graphql(ENSURE_CART_TRANSFORM_MUTATION, {
      variables: {
        functionHandle: SQM_CART_TRANSFORM_FUNCTION_HANDLE,
        blockOnFailure: false,
      },
    });
    const responseJson = await response.json();
    const topLevelErrors = responseJson.errors ?? [];

    if (topLevelErrors.length > 0) {
      const normalizedMessages = topLevelErrors
        .map((error: { message?: string }) => String(error?.message ?? ""))
        .filter(Boolean)
        .join(" ");

      if (/access denied/i.test(normalizedMessages)) {
        // Fallback for stores where functionHandle path fails but functionId works.
        const functionId = await findSqmCartTransformFunctionId(admin);
        if (functionId) {
          const byIdResult = await ensureSqmCartTransformByFunctionId(admin, functionId);
          if (byIdResult.ok) return byIdResult;
        }

        return {
          ok: false,
          message:
            "Cart transform access was denied. Ensure the app has `write_cart_transforms`, your staff account has Products and Preferences permission, and the store is upgraded to Checkout Extensibility.",
        };
      }

      if (/could not find function|function.*not found/i.test(normalizedMessages)) {
        return {
          ok: false,
          message:
            "SQM function handle was not found in this store. Keep `shopify app dev` running (or deploy the app), then save rows again.",
        };
      }

      return {
        ok: false,
        message: topLevelErrors[0]?.message ?? "Unable to activate cart transform for SQM pricing.",
      };
    }

    const userErrors = responseJson.data?.cartTransformCreate?.userErrors ?? [];

    if (userErrors.length === 0) {
      return { ok: true };
    }

    const normalizedMessages = userErrors
      .map((error: { message?: string }) => String(error?.message ?? ""))
      .filter(Boolean)
      .join(" ");

    if (/already exists|only.*cart transform/i.test(normalizedMessages)) {
      if (await isSqmCartTransformAlreadyActive(admin)) {
        return { ok: true };
      }

      return {
        ok: false,
        message:
          "Another cart transform is already active in this store. Remove or disable the existing cart transform, then save rows again.",
      };
    }

    if (/could not find function|function.*not found/i.test(normalizedMessages)) {
      return {
        ok: false,
        message:
          "SQM function handle was not found in this store. Keep `shopify app dev` running (or deploy the app), then save rows again.",
      };
    }

    return {
      ok: false,
      message:
        userErrors[0]?.message ??
        "Unable to activate cart transform for SQM pricing.",
    };
  } catch (error) {
    return {
      ok: false,
      message:
        "Unable to activate cart transform. Re-authenticate the app with cart transform scopes, then save rows again.",
    };
  }
}

async function fetchProducts(admin: { graphql: Function }): Promise<ProductConfig[]> {
  const response = await admin.graphql(PRODUCT_QUERY);
  const responseJson = await response.json();
  const edges = (responseJson.data?.products?.edges ?? []) as ProductEdge[];

  return edges.map((edge) => {
    const node = edge.node;

    return {
      id: node.id,
      title: node.title,
      handle: node.handle,
      status: node.status,
      enableSqmPricing: node.enableSqmPricing?.value === "true",
      minLength: node.minLength?.value ?? toDecimalString(DEFAULT_MIN_LENGTH_METERS),
      maxLength: node.maxLength?.value ?? toDecimalString(DEFAULT_MAX_LENGTH_METERS),
      minWidth: node.minWidth?.value ?? toDecimalString(DEFAULT_MIN_WIDTH_METERS),
      maxWidth: node.maxWidth?.value ?? toDecimalString(DEFAULT_MAX_WIDTH_METERS),
    };
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const products = await fetchProducts(admin);

  return { products } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const rowProductIds = formData.getAll("rowProductId").map((value) => String(value).trim());
  const rowProductQueries = formData
    .getAll("rowProductQuery")
    .map((value) => String(value).trim());
  const rowMinLengths = formData.getAll("rowMinLength");
  const rowMaxLengths = formData.getAll("rowMaxLength");
  const rowMinWidths = formData.getAll("rowMinWidth");
  const rowMaxWidths = formData.getAll("rowMaxWidth");

  const products = await fetchProducts(admin);
  const productMap = new Map(products.map((product) => [product.id, product]));

  const selectedRows = new Map<
    string,
    { minLength: number; maxLength: number; minWidth: number; maxWidth: number }
  >();

  for (let index = 0; index < rowProductIds.length; index += 1) {
    const productId = rowProductIds[index] ?? "";
    const productQuery = rowProductQueries[index] ?? "";

    if (!productId) {
      if (productQuery) {
        return {
          ok: false,
          message: `Row ${index + 1}: choose a product from the dropdown after searching.`,
        } satisfies ActionData;
      }
      continue;
    }

    if (!productMap.has(productId)) {
      return {
        ok: false,
        message: `Row ${index + 1}: selected product is not valid anymore.`,
      } satisfies ActionData;
    }

    if (selectedRows.has(productId)) {
      return {
        ok: false,
        message: `Row ${index + 1}: duplicate product selected. Keep one row per product.`,
      } satisfies ActionData;
    }

    const minLengthMm = parsePositiveDecimal(rowMinLengths[index] ?? null);
    const maxLengthMm = parsePositiveDecimal(rowMaxLengths[index] ?? null);
    const minWidthMm = parsePositiveDecimal(rowMinWidths[index] ?? null);
    const maxWidthMm = parsePositiveDecimal(rowMaxWidths[index] ?? null);

    if (minLengthMm === null || maxLengthMm === null || minWidthMm === null || maxWidthMm === null) {
      return {
        ok: false,
        message: `Row ${index + 1}: min/max values must be valid numbers greater than 0 (mm).`,
      } satisfies ActionData;
    }

    if (minLengthMm > maxLengthMm || minWidthMm > maxWidthMm) {
      return {
        ok: false,
        message: `Row ${index + 1}: minimum values must be less than or equal to maximum values.`,
      } satisfies ActionData;
    }

    selectedRows.set(productId, {
      minLength: millimetersToMeters(minLengthMm),
      maxLength: millimetersToMeters(maxLengthMm),
      minWidth: millimetersToMeters(minWidthMm),
      maxWidth: millimetersToMeters(maxWidthMm),
    });
  }

  const metafieldsToSet: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }> = [];

  products.forEach((product) => {
    const selected = selectedRows.get(product.id);

    if (selected) {
      metafieldsToSet.push(
        {
          ownerId: product.id,
          namespace: "custom",
          key: "enable_sqm_pricing",
          type: "boolean",
          value: "true",
        },
        {
          ownerId: product.id,
          namespace: "custom",
          key: "min_length",
          type: "number_decimal",
          value: toDecimalString(selected.minLength),
        },
        {
          ownerId: product.id,
          namespace: "custom",
          key: "max_length",
          type: "number_decimal",
          value: toDecimalString(selected.maxLength),
        },
        {
          ownerId: product.id,
          namespace: "custom",
          key: "min_width",
          type: "number_decimal",
          value: toDecimalString(selected.minWidth),
        },
        {
          ownerId: product.id,
          namespace: "custom",
          key: "max_width",
          type: "number_decimal",
          value: toDecimalString(selected.maxWidth),
        },
      );
      return;
    }

    if (product.enableSqmPricing) {
      metafieldsToSet.push({
        ownerId: product.id,
        namespace: "custom",
        key: "enable_sqm_pricing",
        type: "boolean",
        value: "false",
      });
    }
  });

  for (const batch of chunkArray(metafieldsToSet, METAFIELDS_SET_BATCH_LIMIT)) {
    if (batch.length === 0) continue;

    const response = await admin.graphql(SET_METAFIELDS_MUTATION, {
      variables: { metafields: batch },
    });
    const responseJson = await response.json();
    const userErrors = responseJson.data?.metafieldsSet?.userErrors ?? [];

    if (userErrors.length > 0) {
      return {
        ok: false,
        message: userErrors[0]?.message ?? "Unable to save calculator rows.",
      } satisfies ActionData;
    }
  }

  const cartTransformResult = await ensureSqmCartTransform(admin);
  if (!cartTransformResult.ok) {
    return {
      ok: false,
      message: cartTransformResult.message ?? "Unable to activate cart transform.",
    } satisfies ActionData;
  }

  return {
    ok: true,
    message: `Saved. ${selectedRows.size} product row(s) are now using the calculator and cart pricing transform is active.`,
  } satisfies ActionData;
};

export default function SqmPricingPage() {
  const { products } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const productsWithLabel = useMemo(
    () =>
      products.map((product) => ({
        ...product,
        label: buildProductLabel(product),
      })),
    [products],
  );

  const productIdByLabel = useMemo(
    () => new Map(productsWithLabel.map((entry) => [entry.label, entry.id])),
    [productsWithLabel],
  );

  const productById = useMemo(
    () => new Map(productsWithLabel.map((entry) => [entry.id, entry])),
    [productsWithLabel],
  );

  const [rows, setRows] = useState<RowState[]>(() => buildInitialRows(products));

  useEffect(() => {
    setRows(buildInitialRows(products));
  }, [products]);

  function updateRow(key: string, updater: (row: RowState) => RowState) {
    setRows((currentRows) =>
      currentRows.map((row) => {
        if (row.key !== key) return row;
        return updater(row);
      }),
    );
  }

  function addRow() {
    setRows((currentRows) => {
      const nextIndex = currentRows.length;
      return [...currentRows, createEmptyRow(`row-${nextIndex}-${Date.now()}`)];
    });
  }

  function removeRow(key: string) {
    setRows((currentRows) => {
      const filteredRows = currentRows.filter((row) => row.key !== key);
      return filteredRows.length > 0 ? filteredRows : [createEmptyRow("row-0")];
    });
  }

  return (
    <s-page heading="Publish Calculator Rows">
      <s-section>
        <s-paragraph>
          Add one row per product. Search the product, choose it from the dropdown, then set
          min/max dimensions in millimeters (mm).
        </s-paragraph>
      </s-section>

      {actionData && (
        <s-section>
          <s-banner
            tone={actionData.ok ? "success" : "critical"}
            heading={actionData.ok ? "Rows saved" : "Unable to save rows"}
          >
            <s-paragraph>{actionData.message}</s-paragraph>
          </s-banner>
        </s-section>
      )}

      <s-section heading="Calculator Rows">
        <Form method="post">
          <s-stack direction="block" gap="base">
            {rows.map((row, index) => {
              const normalizedQuery = row.productQuery.trim().toLowerCase();
              const searchMatches = productsWithLabel
                .filter((product) => {
                  if (!normalizedQuery) return true;
                  const haystack = `${product.title} ${product.handle}`.toLowerCase();
                  return haystack.includes(normalizedQuery);
                })
                .slice(0, MAX_PRODUCT_MATCH_OPTIONS);

              const selectedProduct = row.productId ? productById.get(row.productId) : undefined;
              const hasSelectedInMatches = selectedProduct
                ? searchMatches.some((product) => product.id === selectedProduct.id)
                : false;

              const selectOptions = selectedProduct && !hasSelectedInMatches
                ? [selectedProduct, ...searchMatches]
                : searchMatches;

              return (
                <s-box key={row.key} border="base" borderRadius="base" padding="base">
                  <s-stack direction="block" gap="base">
                    <s-heading>Row {index + 1}</s-heading>

                    <s-grid gap="base" gridTemplateColumns="repeat(auto-fit, minmax(18rem, 1fr))">
                      <s-search-field
                        label="Product search"
                        value={row.productQuery}
                        placeholder="Type title or handle"
                        onInput={(event: Event) => {
                          const nextQuery = (event.currentTarget as HTMLInputElement).value;
                          const exactMatchProductId = productIdByLabel.get(nextQuery) ?? "";

                          updateRow(row.key, (currentRow) => ({
                            ...currentRow,
                            productQuery: nextQuery,
                            productId: exactMatchProductId,
                          }));
                        }}
                      />

                      <s-select
                        label="Choose product"
                        value={row.productId}
                        placeholder="Select product"
                        onInput={(event: Event) => {
                          const nextProductId = (event.currentTarget as HTMLInputElement).value;
                          const selected = productById.get(nextProductId);

                          updateRow(row.key, (currentRow) => ({
                            ...currentRow,
                            productId: nextProductId,
                            productQuery: selected ? selected.label : currentRow.productQuery,
                          }));
                        }}
                      >
                        <s-option value="">Select product</s-option>
                        {selectOptions.map((product) => (
                          <s-option key={`${row.key}-${product.id}`} value={product.id}>
                            {product.label}
                          </s-option>
                        ))}
                      </s-select>
                    </s-grid>

                    <s-grid gap="base" gridTemplateColumns="repeat(auto-fit, minmax(12rem, 1fr))">
                      <s-number-field
                        label="Min length (mm)"
                        min="0.1"
                        step="0.01"
                        value={row.minLength}
                        onInput={(event: Event) => {
                          const nextValue = (event.currentTarget as HTMLInputElement).value;
                          updateRow(row.key, (currentRow) => ({
                            ...currentRow,
                            minLength: nextValue,
                          }));
                        }}
                      />

                      <s-number-field
                        label="Max length (mm)"
                        min="0.1"
                        step="0.01"
                        value={row.maxLength}
                        onInput={(event: Event) => {
                          const nextValue = (event.currentTarget as HTMLInputElement).value;
                          updateRow(row.key, (currentRow) => ({
                            ...currentRow,
                            maxLength: nextValue,
                          }));
                        }}
                      />

                      <s-number-field
                        label="Min width (mm)"
                        min="0.1"
                        step="0.01"
                        value={row.minWidth}
                        onInput={(event: Event) => {
                          const nextValue = (event.currentTarget as HTMLInputElement).value;
                          updateRow(row.key, (currentRow) => ({
                            ...currentRow,
                            minWidth: nextValue,
                          }));
                        }}
                      />

                      <s-number-field
                        label="Max width (mm)"
                        min="0.1"
                        step="0.01"
                        value={row.maxWidth}
                        onInput={(event: Event) => {
                          const nextValue = (event.currentTarget as HTMLInputElement).value;
                          updateRow(row.key, (currentRow) => ({
                            ...currentRow,
                            maxWidth: nextValue,
                          }));
                        }}
                      />
                    </s-grid>

                    <s-button type="button" variant="secondary" tone="critical" onClick={() => removeRow(row.key)}>
                      Remove row {index + 1}
                    </s-button>

                    <input type="hidden" name="rowProductQuery" value={row.productQuery} />
                    <input type="hidden" name="rowProductId" value={row.productId} />
                    <input type="hidden" name="rowMinLength" value={row.minLength} />
                    <input type="hidden" name="rowMaxLength" value={row.maxLength} />
                    <input type="hidden" name="rowMinWidth" value={row.minWidth} />
                    <input type="hidden" name="rowMaxWidth" value={row.maxWidth} />
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>

          <s-box paddingBlockStart="base">
            <s-stack direction="inline" gap="base">
              <s-button type="button" variant="secondary" onClick={addRow}>
                Add row
              </s-button>
              <s-button type="submit" variant="primary" {...(isSubmitting ? { loading: true } : {})}>
                Save rows
              </s-button>
            </s-stack>
          </s-box>
        </Form>
      </s-section>
    </s-page>
  );
}
