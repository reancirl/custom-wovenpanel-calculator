import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

type ProductConfig = {
  id: string;
  title: string;
  handle: string;
  status: string;
  enableSqmPricing: boolean;
  pricePerSqm: string;
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
  productId?: string;
  message: string;
};

type ProductMetafieldNode = {
  key: string;
  value: string | null;
} | null;

type ProductNode = {
  id: string;
  title: string;
  handle: string;
  status: string;
  metafields: ProductMetafieldNode[];
};

type ProductEdge = {
  node: ProductNode;
};

const DEFAULT_MIN_LENGTH = "0.1";
const DEFAULT_MAX_LENGTH = "100";
const DEFAULT_MIN_WIDTH = "0.1";
const DEFAULT_MAX_WIDTH = "100";
const DEFAULT_PRICE_PER_SQM = "500";

const PRODUCT_QUERY = `#graphql
  query SqmPricingProducts {
    products(first: 50, sortKey: UPDATED_AT, reverse: true) {
      edges {
        node {
          id
          title
          handle
          status
          metafields(
            identifiers: [
              { namespace: "custom", key: "enable_sqm_pricing" }
              { namespace: "custom", key: "price_per_sqm" }
              { namespace: "custom", key: "min_length" }
              { namespace: "custom", key: "max_length" }
              { namespace: "custom", key: "min_width" }
              { namespace: "custom", key: "max_width" }
            ]
          ) {
            key
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
      metafields {
        id
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function parseDecimal(value: FormDataEntryValue | null): number | null {
  if (value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return null;

  return parsed;
}

function toDecimalString(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return rounded.toString();
}

function toMetafieldMap(metafields: ProductMetafieldNode[]): Record<string, string> {
  return metafields.reduce<Record<string, string>>((accumulator, metafield) => {
    if (metafield?.key && typeof metafield.value === "string") {
      accumulator[metafield.key] = metafield.value;
    }

    return accumulator;
  }, {});
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(PRODUCT_QUERY);
  const responseJson = await response.json();
  const edges = (responseJson.data?.products?.edges ?? []) as ProductEdge[];

  const products: ProductConfig[] = edges.map((edge) => {
    const node = edge.node;
    const metafieldMap = toMetafieldMap(node.metafields ?? []);

    return {
      id: node.id,
      title: node.title,
      handle: node.handle,
      status: node.status,
      enableSqmPricing: metafieldMap.enable_sqm_pricing === "true",
      pricePerSqm: metafieldMap.price_per_sqm ?? DEFAULT_PRICE_PER_SQM,
      minLength: metafieldMap.min_length ?? DEFAULT_MIN_LENGTH,
      maxLength: metafieldMap.max_length ?? DEFAULT_MAX_LENGTH,
      minWidth: metafieldMap.min_width ?? DEFAULT_MIN_WIDTH,
      maxWidth: metafieldMap.max_width ?? DEFAULT_MAX_WIDTH,
    };
  });

  return { products } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const productId = String(formData.get("productId") ?? "").trim();

  if (!productId) {
    return {
      ok: false,
      message: "Missing product ID.",
    } satisfies ActionData;
  }

  const enableSqmPricing = String(formData.get("enableSqmPricing") ?? "false") === "true";

  const pricePerSqm = parseDecimal(formData.get("pricePerSqm"));
  const minLength = parseDecimal(formData.get("minLength"));
  const maxLength = parseDecimal(formData.get("maxLength"));
  const minWidth = parseDecimal(formData.get("minWidth"));
  const maxWidth = parseDecimal(formData.get("maxWidth"));

  if (pricePerSqm === null || pricePerSqm <= 0) {
    return {
      ok: false,
      productId,
      message: "Price per sqm must be a valid number greater than 0.",
    } satisfies ActionData;
  }

  if (minLength === null || minLength <= 0 || maxLength === null || maxLength <= 0) {
    return {
      ok: false,
      productId,
      message: "Length limits must be valid numbers greater than 0.",
    } satisfies ActionData;
  }

  if (minWidth === null || minWidth <= 0 || maxWidth === null || maxWidth <= 0) {
    return {
      ok: false,
      productId,
      message: "Width limits must be valid numbers greater than 0.",
    } satisfies ActionData;
  }

  if (minLength > maxLength || minWidth > maxWidth) {
    return {
      ok: false,
      productId,
      message: "Minimum values must be less than or equal to maximum values.",
    } satisfies ActionData;
  }

  const metafields = [
    {
      ownerId: productId,
      namespace: "custom",
      key: "enable_sqm_pricing",
      type: "boolean",
      value: enableSqmPricing ? "true" : "false",
    },
    {
      ownerId: productId,
      namespace: "custom",
      key: "price_per_sqm",
      type: "number_decimal",
      value: toDecimalString(pricePerSqm),
    },
    {
      ownerId: productId,
      namespace: "custom",
      key: "min_length",
      type: "number_decimal",
      value: toDecimalString(minLength),
    },
    {
      ownerId: productId,
      namespace: "custom",
      key: "max_length",
      type: "number_decimal",
      value: toDecimalString(maxLength),
    },
    {
      ownerId: productId,
      namespace: "custom",
      key: "min_width",
      type: "number_decimal",
      value: toDecimalString(minWidth),
    },
    {
      ownerId: productId,
      namespace: "custom",
      key: "max_width",
      type: "number_decimal",
      value: toDecimalString(maxWidth),
    },
  ];

  const response = await admin.graphql(SET_METAFIELDS_MUTATION, {
    variables: { metafields },
  });

  const responseJson = await response.json();
  const userErrors = responseJson.data?.metafieldsSet?.userErrors ?? [];

  if (userErrors.length > 0) {
    return {
      ok: false,
      productId,
      message: userErrors[0]?.message ?? "Unable to save SQM settings.",
    } satisfies ActionData;
  }

  return {
    ok: true,
    productId,
    message: "SQM pricing settings saved.",
  } satisfies ActionData;
};

export default function SqmPricingPage() {
  const { products } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submittingProductId = navigation.formData?.get("productId")?.toString();

  return (
    <s-page heading="SQM pricing configuration">
      <s-section>
        <s-paragraph>
          Configure per-product area pricing using product metafields in the <code>custom</code>
          namespace. The cart transform function applies this only when
          <code> custom.enable_sqm_pricing </code>
          is true.
        </s-paragraph>
      </s-section>

      {actionData && (
        <s-section>
          <div
            style={{
              border: "1px solid #d1d5db",
              borderRadius: "12px",
              padding: "12px 16px",
              background: actionData.ok ? "#e8f7ee" : "#fdecec",
              color: actionData.ok ? "#0f5132" : "#842029",
            }}
          >
            {actionData.message}
          </div>
        </s-section>
      )}

      <s-section heading="Products">
        <div
          style={{
            display: "grid",
            gap: "16px",
          }}
        >
          {products.map((product) => {
            const isSubmitting = submittingProductId === product.id;

            return (
              <Form
                key={product.id}
                method="post"
                style={{
                  border: "1px solid #d1d5db",
                  borderRadius: "12px",
                  padding: "16px",
                  display: "grid",
                  gap: "12px",
                }}
              >
                <input type="hidden" name="productId" value={product.id} />

                <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
                  <div>
                    <strong>{product.title}</strong>
                    <div>
                      <small>
                        {product.handle} • {product.status}
                      </small>
                    </div>
                  </div>
                </div>

                <label style={{ display: "grid", gap: "6px" }}>
                  <span>Enable SQM pricing</span>
                  <select name="enableSqmPricing" defaultValue={String(product.enableSqmPricing)}>
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                </label>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: "10px",
                  }}
                >
                  <label style={{ display: "grid", gap: "6px" }}>
                    <span>Price per sqm</span>
                    <input
                      name="pricePerSqm"
                      type="number"
                      min="0.01"
                      step="0.01"
                      defaultValue={product.pricePerSqm}
                      required
                    />
                  </label>

                  <label style={{ display: "grid", gap: "6px" }}>
                    <span>Min length (m)</span>
                    <input
                      name="minLength"
                      type="number"
                      min="0.01"
                      step="0.01"
                      defaultValue={product.minLength}
                      required
                    />
                  </label>

                  <label style={{ display: "grid", gap: "6px" }}>
                    <span>Max length (m)</span>
                    <input
                      name="maxLength"
                      type="number"
                      min="0.01"
                      step="0.01"
                      defaultValue={product.maxLength}
                      required
                    />
                  </label>

                  <label style={{ display: "grid", gap: "6px" }}>
                    <span>Min width (m)</span>
                    <input
                      name="minWidth"
                      type="number"
                      min="0.01"
                      step="0.01"
                      defaultValue={product.minWidth}
                      required
                    />
                  </label>

                  <label style={{ display: "grid", gap: "6px" }}>
                    <span>Max width (m)</span>
                    <input
                      name="maxWidth"
                      type="number"
                      min="0.01"
                      step="0.01"
                      defaultValue={product.maxWidth}
                      required
                    />
                  </label>
                </div>

                <div>
                  <button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? "Saving..." : "Save SQM settings"}
                  </button>
                </div>
              </Form>
            );
          })}
        </div>
      </s-section>
    </s-page>
  );
}
