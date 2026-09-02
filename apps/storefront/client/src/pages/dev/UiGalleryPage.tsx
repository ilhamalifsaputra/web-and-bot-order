/**
 * Dev-only primitive gallery — the Fase 6 phase-gate surface and the visual-QA
 * reference for later tasks. Mounted at `/__ui` in App.tsx behind
 * `import.meta.env.DEV`, lazy-imported, so it never reaches the production
 * bundle or the nav.
 *
 * Every primitive in `components/ui/` is rendered here with every
 * variant / size / state (invalid, disabled, hover note). No business data,
 * no API calls, no router — just the primitives.
 */
import { useState } from "react";
import { Flame, X, ChevronLeft, Info } from "lucide-react";
import Button from "../../components/ui/Button";
import IconButton from "../../components/ui/IconButton";
import Input from "../../components/ui/Input";
import Textarea from "../../components/ui/Textarea";
import Select from "../../components/ui/Select";
import Label from "../../components/ui/Label";
import FormField from "../../components/ui/FormField";
import Checkbox from "../../components/ui/Checkbox";
import Radio from "../../components/ui/Radio";
import Switch from "../../components/ui/Switch";
import Card from "../../components/ui/Card";
import Badge from "../../components/ui/Badge";
import Divider from "../../components/ui/Divider";
import Skeleton from "../../components/ui/Skeleton";
import Spinner from "../../components/ui/Spinner";
import Modal from "../../components/ui/Modal";
import AlertDialog from "../../components/ui/AlertDialog";
import Tabs from "../../components/ui/Tabs";
import Accordion from "../../components/ui/Accordion";
import Alert, { type AlertTone } from "../../components/ui/Alert";
import Toast from "../../components/ui/Toast";
import Tooltip from "../../components/ui/Tooltip";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="section-title mb-3">{title}</h2>
      <div className="flex flex-wrap items-start gap-4">{children}</div>
    </section>
  );
}

const ALERT_TONES: AlertTone[] = ["info", "success", "warning", "error", "tip"];

export default function UiGalleryPage() {
  const [switchOn, setSwitchOn] = useState(false);
  const [checked, setChecked] = useState(true);
  const [radio, setRadio] = useState("a");
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmPending, setConfirmPending] = useState(false);
  const [tab, setTab] = useState("cheap");
  const [toast, setToast] = useState<string | null>(null);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="page-title">UI primitives</h1>
      <p className="page-lead">
        Dev-only gallery (<code className="codeish">/__ui</code>). Every{" "}
        <code className="codeish">components/ui</code> primitive, every variant and state.
      </p>

      <Section title="Button — variants">
        <Button variant="primary">Primary</Button>
        <Button variant="soft">Soft</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
      </Section>

      <Section title="Button — size sm">
        <Button variant="primary" size="sm">
          Primary
        </Button>
        <Button variant="soft" size="sm">
          Soft
        </Button>
        <Button variant="ghost" size="sm">
          Ghost
        </Button>
        <Button variant="danger" size="sm">
          Danger
        </Button>
      </Section>

      <Section title="Button — disabled / fullWidth / pending">
        <Button variant="primary" disabled>
          Disabled
        </Button>
        <Button variant="danger" disabled>
          Disabled
        </Button>
        <Button variant="primary" disabled>
          <Spinner />
          Submitting
        </Button>
        <div className="w-full">
          <Button variant="primary" fullWidth>
            Full width
          </Button>
        </div>
      </Section>

      <Section title="IconButton (md 44px / sm 32px)">
        <IconButton aria-label="Previous">
          <ChevronLeft className="h-5 w-5" />
        </IconButton>
        <IconButton aria-label="Close">
          <X className="h-5 w-5" />
        </IconButton>
        <IconButton aria-label="Close small" size="sm">
          <X className="h-4 w-4" />
        </IconButton>
        <IconButton aria-label="Disabled" disabled>
          <X className="h-5 w-5" />
        </IconButton>
      </Section>

      <Section title="Input">
        <div className="w-64">
          <Input placeholder="Normal field" />
        </div>
        <div className="w-64">
          <Input placeholder="Invalid field" invalid defaultValue="bad@" />
        </div>
        <div className="w-64">
          <Input placeholder="Disabled" disabled />
        </div>
      </Section>

      <Section title="Textarea">
        <div className="w-64">
          <Textarea placeholder="Normal" rows={3} />
        </div>
        <div className="w-64">
          <Textarea placeholder="Invalid" invalid rows={3} />
        </div>
      </Section>

      <Section title="Select">
        <div className="w-64">
          <Select defaultValue="">
            <option value="" disabled>
              Pick one…
            </option>
            <option value="a">Option A</option>
            <option value="b">Option B</option>
          </Select>
        </div>
        <div className="w-64">
          <Select invalid defaultValue="a">
            <option value="a">Invalid</option>
          </Select>
        </div>
      </Section>

      <Section title="Label">
        <Label>Plain label</Label>
        <Label required>Required label</Label>
      </Section>

      <Section title="FormField (label + hint + error wiring)">
        <div className="w-72">
          <FormField label="Email" hint="We never share it.">
            <Input type="email" placeholder="you@example.com" />
          </FormField>
        </div>
        <div className="w-72">
          <FormField label="User ID" required error="Isi User ID kamu dulu ya.">
            <Input placeholder="123456" defaultValue="" />
          </FormField>
        </div>
        <div className="w-72">
          <FormField label="Notes" hint="Optional.">
            <Textarea rows={2} />
          </FormField>
        </div>
      </Section>

      <Section title="Checkbox / Radio">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          Controlled checkbox
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox disabled />
          Disabled
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Radio name="demo" value="a" checked={radio === "a"} onChange={() => setRadio("a")} />
          Radio A
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Radio name="demo" value="b" checked={radio === "b"} onChange={() => setRadio("b")} />
          Radio B
        </label>
      </Section>

      <Section title="Switch">
        <Switch checked={switchOn} onCheckedChange={setSwitchOn} aria-label="Demo toggle" />
        <span className="text-sm text-ink-soft">{switchOn ? "on" : "off"}</span>
        <Switch checked disabled onCheckedChange={() => {}} aria-label="Disabled on" />
        <Switch checked={false} disabled onCheckedChange={() => {}} aria-label="Disabled off" />
      </Section>

      <Section title="Card">
        <Card className="w-64">Default card (padded)</Card>
        <Card className="w-64" padded={false}>
          <div className="p-2 text-sm">padded=false</div>
        </Card>
        <Card className="w-64" interactive>
          Interactive — hover for shadow-lift
        </Card>
      </Section>

      <Section title="Badge">
        <Badge variant="discount">15% OFF</Badge>
        <Badge variant="savings">Hemat Rp150</Badge>
        <Badge variant="hot" icon={<Flame className="h-3.5 w-3.5" />}>
          Hot
        </Badge>
        <Badge variant="category">topup</Badge>
        <Badge variant="neutral">neutral</Badge>
        <Badge variant="success">success</Badge>
        <Badge variant="pending">pending</Badge>
        <Badge variant="failed">failed</Badge>
      </Section>

      <Section title="Divider">
        <div className="w-64">
          above
          <Divider className="my-2" />
          below
        </div>
        <div className="flex h-10 items-center gap-3">
          left
          <Divider orientation="vertical" />
          right
        </div>
      </Section>

      <Section title="Skeleton / Spinner">
        <div className="w-64 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
        <span className="inline-flex items-center text-sm text-ink-soft">
          <Spinner />
          loading
        </span>
      </Section>

      <Section title="Modal">
        <Button variant="soft" onClick={() => setModalOpen(true)}>
          Open modal
        </Button>
        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Modal title"
          description="Derived from Card + tokens; a11y from the MobileDrawer pattern."
          footer={
            <>
              <Button variant="ghost" onClick={() => setModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setModalOpen(false)}>
                Confirm
              </Button>
            </>
          }
        >
          <p>
            Focus is trapped here, Esc closes, the scrim closes, body scroll is locked, and focus
            returns to the trigger on close.
          </p>
        </Modal>
      </Section>

      <Section title="AlertDialog (destructive confirm)">
        <Button variant="danger" onClick={() => setConfirmOpen(true)}>
          Delete something
        </Button>
        <AlertDialog
          open={confirmOpen}
          tone="danger"
          confirmPending={confirmPending}
          title="Delete this item?"
          description="This action cannot be undone."
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmPending(true);
            window.setTimeout(() => {
              setConfirmPending(false);
              setConfirmOpen(false);
            }, 1200);
          }}
        />
      </Section>

      <Section title="Tabs — segmented control (with panels)">
        <div className="w-full">
          <Tabs
            aria-label="Pricing view"
            value={tab}
            onValueChange={setTab}
            items={[
              { value: "cheap", label: "Termurah" },
              { value: "member", label: "Membership" },
              { value: "diamonds", label: "Diamonds" },
              { value: "soon", label: "Coming soon", disabled: true },
            ]}
            panels={{
              cheap: <p className="text-sm text-ink-soft">Cheapest-first listing.</p>,
              member: <p className="text-sm text-ink-soft">Membership packages.</p>,
              diamonds: <p className="text-sm text-ink-soft">Diamond top-ups.</p>,
              soon: <p className="text-sm text-ink-soft">Not available yet.</p>,
            }}
          />
        </div>
      </Section>

      <Section title="Accordion — single (FAQ)">
        <div className="w-full max-w-xl">
          <Accordion
            defaultValue="ship"
            items={[
              {
                value: "ship",
                trigger: "How fast is delivery?",
                content: "Instantly after your payment is confirmed.",
              },
              {
                value: "refund",
                trigger: "Can I get a refund?",
                content: "Yes — within 24 hours if the item was not delivered.",
              },
              {
                value: "safe",
                trigger: "Is my account safe?",
                content: "We never store your password and only ask for what a top-up needs.",
              },
            ]}
          />
        </div>
      </Section>

      <Section title="Accordion — multiple">
        <div className="w-full max-w-xl">
          <Accordion
            type="multiple"
            defaultValue={["a"]}
            items={[
              { value: "a", trigger: "First", content: "First body." },
              { value: "b", trigger: "Second", content: "Second body." },
            ]}
          />
        </div>
      </Section>

      <Section title="Alert — banner (ex-Flash)">
        <div className="w-full max-w-xl space-y-3">
          {ALERT_TONES.map((tone) => (
            <Alert key={tone} variant="banner" tone={tone}>
              Banner alert, tone <strong>{tone}</strong>.
            </Alert>
          ))}
          <Alert variant="banner" tone="error" title="With a title">
            Extra detail under the bold lead line.
          </Alert>
        </div>
      </Section>

      <Section title="Alert — panel (ex-Callout)">
        <div className="w-full max-w-xl space-y-3">
          {ALERT_TONES.map((tone) => (
            <Alert key={tone} variant="panel" tone={tone}>
              Panel alert, tone <strong>{tone}</strong>.
            </Alert>
          ))}
        </div>
      </Section>

      <Section title="Toast">
        <Button variant="soft" onClick={() => setToast("Saved to your account.")}>
          Trigger toast
        </Button>
        <Toast text={toast} onDismiss={() => setToast(null)} />
      </Section>

      <Section title="Tooltip">
        <Tooltip label="Copied to clipboard">
          <Button variant="ghost" size="sm">
            Hover or focus me
          </Button>
        </Tooltip>
        <Tooltip label="More info about this field">
          <IconButton aria-label="Info" size="sm">
            <Info className="h-4 w-4" />
          </IconButton>
        </Tooltip>
      </Section>
    </main>
  );
}
