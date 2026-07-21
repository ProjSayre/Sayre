/* Fixture: .jsx uses the "javascript" grammar (not "tsx") — a function
 * component returning JSX shouldn't break extraction of the surrounding
 * function/call constructs. */

import React from "react";

function Widget(props) {
  return <div className="widget">{props.label}</div>;
}

const List = (props) => {
  return <ul>{props.items}</ul>;
};
