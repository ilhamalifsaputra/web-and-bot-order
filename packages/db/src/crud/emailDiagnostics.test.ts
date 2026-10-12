import { describe, expect, it } from "vitest";
import { classifyEmailDelivery } from "./emailDiagnostics";

describe("historical email evidence classification", () => {
  it("keeps historical SENT without acceptance evidence uncertain", () => {
    expect(classifyEmailDelivery({event:"OWNER_EMAIL_ORDER_PAID",status:"SENT",payloadJson:JSON.stringify({to:"private@example.com"}),fulfillmentProvider:"DIGIFLAZZ"})).toEqual({outcome:"sent_without_evidence",legacySuppressionCandidate:true,hasRecipient:true});
  });
  it("classifies recorded acceptance as transport evidence only", () => {
    expect(classifyEmailDelivery({event:"BUYER_EMAIL_ORDER_READY",status:"SENT",payloadJson:JSON.stringify({to:"buyer@example.com",delivery:{messageId:"<mail>",acceptedAt:"2026-10-12T00:00:00.000Z"}}),fulfillmentProvider:null})).toEqual({outcome:"transport_accepted",legacySuppressionCandidate:false,hasRecipient:true});
  });
  it("never invents acceptance from a recipient, status, or invalid payload", () => {
    for(const payloadJson of ["broken", "null", "{}"]) expect(classifyEmailDelivery({event:"OWNER_EMAIL_WALLET_TOPUP",status:"FAILED",payloadJson,fulfillmentProvider:null})).toEqual({outcome:"not_sent",legacySuppressionCandidate:false,hasRecipient:false});
  });
});
