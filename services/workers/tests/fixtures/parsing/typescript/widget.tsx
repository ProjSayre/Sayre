/* Fixture: .tsx selects the "tsx" grammar (distinct from "typescript") —
 * a typed function component returning JSX shouldn't break extraction. */

import React from "react";

interface WidgetProps {
  label: string;
}

function Widget(props: WidgetProps) {
  return <div className="widget">{props.label}</div>;
}

const List = (props: { items: string[] }) => {
  return <ul>{props.items}</ul>;
};
