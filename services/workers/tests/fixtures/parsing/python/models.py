"""Fixture: a base class, a subclass with multiple bases, and a plain mixin
class with no bases — exercises ParsedClass, ParsedInheritance (incl.
multi-base), methods vs module-level functions, and self.method() calls."""

from __future__ import annotations


class Animal:
    def __init__(self, name):
        self.name = name

    def speak(self):
        return self.describe()

    def describe(self):
        return f"{self.name} makes a sound"


class Loggable:
    def log(self):
        print(self)


class Dog(Animal, Loggable):
    def speak(self):
        self.log()
        return super().speak()


def make_dog(name):
    return Dog(name)
