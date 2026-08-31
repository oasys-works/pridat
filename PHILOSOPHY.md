# Philosophy

Part I is what we want to make. Part II is how we work.

What we claim lives beside the program that earned it. Here we write the reason
only. A reason survives the next machine. A claim is owed a rerun.

If the language is loose, the thought is loose.

---

# Part I. What we want to make

## 1. The engine owns the placement, and we want it back

JavaScript chooses where an object lives. It can move the object. It can add
hidden fields to it. It removes the object when it decides to.

So a program cannot name a byte. A program that cannot name a byte cannot
promise one to anybody else.

## 2. The layout is the interface

A modern program is many parts. It has JavaScript, WebAssembly, worker threads
and code from other languages.

Each part chooses its own way to hold data. Every boundary between two parts
translates, and translation grows with the data.

We want one layout that all parts read. Then a boundary is not a translation. It
is a position.

## 3. JavaScript keeps control, and we take the data

JavaScript is good at decisions, at events, and at the connection between parts.
It keeps all of that.

We own the data, and where every byte of it sits.

## 4. A machine computes the byte positions

A person can compute them. The result is correct until a field moves. Then every
position after it changes, and nothing tells the person.

The program stays correct in form and wrong in result. That is the failure we
refuse.

## 5. The host already holds the outer limits

An error in our data cannot leave the buffer. It cannot touch the operating
system. It cannot touch another program.

So we do not owe the full safety of C. We owe one thing: the arithmetic must not
lie about which byte it means.

## 6. Safety must be cheap enough that nobody removes it

A check that costs too much gets switched off before release. Then it gives no
protection, and it also says something untrue about what it gives.

Put the check where it is owed. Leave it out where it is not.

## 7. Promise what you can keep

Promise what one row costs. Do not promise what a program costs. A program
reserves memory, grows it, and leaves old blocks behind.

Say where the rest went. A promise you can keep is better than a promise you
like.

## 8. Predictable beats usually good

A person feels the worst case, and not the average.

A number you can compute before you run is worth more than a number that is
usually good.

## 9. The reason is the ability, not the speed

Some of what we want is faster. Some of it does not exist in another form.

Faster is worth having and somebody can reach it without us. The second kind is
the reason to do the work.

## What success looks like

A person writes one description of the data. After that:

- Both sides of a boundary agree on every byte, and no person writes that
  agreement by hand.
- The data moves to another thread with no copy.
- One row costs the number the person computed, and the program says where the
  rest went.
- The program does not stop for data removal during a frame.
- The person never writes a byte position.
- An error stops the program and names the place. The program does not continue
  with a wrong number.

If a person can do all of this, and the work feels usual, then we succeeded.

---

# Part II. How we work

Each rule comes from a real event here, and each one cost us something.

Three words carry one meaning each. An experiment is one program that measures.
An assertion is one check inside an experiment. The suite is the runner that
executes them all.

## 1. Test the base before you build on it

A design rule with no measurement is only an opinion. Correct a bad rule before
code rests on it, because the price rises after.

## 2. Be more careful with a result that agrees with you

A result that disagrees with you gets a second look at once. A result that
agrees with you gets none. That is why the second one is dangerous.

## 3. If a result is not possible, the experiment is wrong

Do not accept a result that breaks a rule you trust. Look for the error first.

## 4. One engine is not all engines

Test on more than one engine. Test on more than one machine. What is free on one
is not free on all.

## 5. Small experiments do not show you a system

They show you the parts. Only a whole one shows you the order the parts belong
in. The wrong order is where the worst results come from.

## 6. Put the pass limit away from the measurement

A limit at the measured number is not a test. Its result is random.

Run each experiment many times. Record the range. Put the limit outside it.

## 7. A wrong idea is a result. Keep it

Do not delete an assertion that refutes. A wrong idea teaches you as much as a
correct one.

The record must show what we learned, and not only what we hoped.

## 8. Write down what you did not test

An untested area is a risk. A risk you write down is a risk you can control.

Never call the work complete while the list has entries.

## 9. When the data changes, change the claim

Change the claim. Never change the data. The longer claim is the true one.

The short claim is the one everybody wants. The narrow claim is the one the data
carries. Keep the bad result in the list.

## 10. Safety must be cheap, or people remove it

Make the check free where you can show it is not owed. Use the slow check only
where you cannot show this.

## 11. Build the small thing first

Learn whether the problem is real before you build the thing that answers it.
Grow the small thing only where it runs out.

## 12. Design for the machine that runs the code

The correct code differs between engines. Code written ahead of time must pick
one shape and keep it.

Build on the engine that will run it. Let the real machine tell you what to do.

## 13. Measure a range, and not a point

A limit has a shape. It can be flat, then a step. It can be a slope. It can be
nothing at all.

One measurement cannot show you a shape. It still gives you a number, and a
number looks complete.

Change one thing, keep the work the same, and look at the whole curve.

## 14. An experiment that does not run tells you nothing, and says nothing

Count what ran. Treat an error as an error, and never as a refutation.

A runner that reports success while nothing arrives is worse than one that
fails.

## 15. Count the work on both sides before you believe a comparison

Count the reads, the bytes, the calls and the new objects on both sides. Do it
before you believe the number, and not after somebody asks.

An error here always flatters the side you want to win.

## 16. Every number in a rule must name a file you can run

A number whose source is gone is the same as a number nobody measured. It is
worse, because it looks like the first kind.

If you cannot run the thing it comes from, take the number out.

## The one rule under all the others

We do not try to be correct. We try to find where we are wrong.

These are not the same. To be correct is a feeling. To find an error is work.

There is a second half. To look for an error, you must first look at the thing.
Care about what a number means does not tell you whether a number arrived.

So look for the place where you are wrong. Also look at whether you are still
looking.
