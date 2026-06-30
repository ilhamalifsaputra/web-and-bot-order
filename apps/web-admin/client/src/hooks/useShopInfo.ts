import { useQuery } from "@tanstack/react-query";

interface ShopInfo {
  shopName: string | null;
}

export function useShopInfo(): ShopInfo {
  const { data } = useQuery<ShopInfo>({
    queryKey: ["shop-info"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) return { shopName: null };
      const json = await res.json() as { fields?: { key: string; value: string }[] };
      const nameField = json.fields?.find((f) => f.key === "shop_name");
      return { shopName: nameField?.value || null };
    },
    staleTime: 5 * 60 * 1000,
  });

  return { shopName: data?.shopName ?? null };
}
