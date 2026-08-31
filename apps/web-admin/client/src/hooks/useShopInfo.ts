import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";

interface ShopInfo {
  shopName: string | null;
}

export function useShopInfo(): ShopInfo {
  const { data } = useQuery<ShopInfo>({
    queryKey: ["shop-info"],
    queryFn: async () => {
      const json = await apiGet<{ fields?: { key: string; value: string }[] }>("/api/settings")
        .catch(() => ({ fields: undefined }));
      const nameField = json.fields?.find((f) => f.key === "shop_name");
      return { shopName: nameField?.value || null };
    },
    staleTime: 5 * 60 * 1000,
  });

  return { shopName: data?.shopName ?? null };
}
