import { Navigate, useLocation } from "react-router-dom";
export default function SupportPage() { const location = useLocation(); return <Navigate to={`/help${location.search}`} replace />; }
